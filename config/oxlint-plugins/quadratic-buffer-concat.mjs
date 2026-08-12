const LOOP_TYPES = new Set([
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement'
])
const ASSIGNMENT_OPERATORS = new Set(['=', '+=', '??=', '||=', '&&='])
const EXPRESSION_WRAPPERS = new Set([
  'ChainExpression',
  'TSAsExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TypeCastExpression'
])

function normalizeReferenceText(text) {
  return text.replaceAll(/\s+/g, '')
}

function sourceText(context, node) {
  return context.sourceCode.getText(node)
}

function memberPropertyName(node) {
  if (node?.type !== 'MemberExpression') {
    return null
  }
  if (!node.computed && node.property.type === 'Identifier') {
    return node.property.name
  }
  return node.property.type === 'Literal' && typeof node.property.value === 'string'
    ? node.property.value
    : null
}

function rootReferenceText(context, node) {
  if (node?.type === 'Identifier') {
    return node.name
  }
  if (node?.type === 'MemberExpression') {
    return node.object.type === 'ThisExpression'
      ? normalizeReferenceText(sourceText(context, node))
      : rootReferenceText(context, node.object)
  }
  if (node?.type === 'CallExpression') {
    return rootReferenceText(context, node.callee)
  }
  if (EXPRESSION_WRAPPERS.has(node?.type)) {
    return rootReferenceText(context, node.expression)
  }
  return null
}

function isBufferConcatCall(node) {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'Buffer' &&
    memberPropertyName(node.callee) === 'concat' &&
    node.arguments[0]?.type === 'ArrayExpression'
  )
}

function enclosingLoop(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (LOOP_TYPES.has(current.type)) {
      return current
    }
  }
  return null
}

function nodeStart(node) {
  return node.start ?? node.range?.[0] ?? 0
}

function nodeEnd(node) {
  return node.end ?? node.range?.[1] ?? 0
}

function isDeclaredInsideLoop(declarationStart, loop) {
  if (declarationStart < nodeStart(loop) || declarationStart >= nodeEnd(loop)) {
    return false
  }
  if (loop.type !== 'ForStatement' || !loop.init) {
    return true
  }
  return declarationStart < nodeStart(loop.init) || declarationStart >= nodeEnd(loop.init)
}

function collectBindingNames(pattern, names) {
  if (!pattern) {
    return
  }
  if (pattern.type === 'Identifier') {
    names.push(pattern.name)
  } else if (pattern.type === 'RestElement') {
    collectBindingNames(pattern.argument, names)
  } else if (pattern.type === 'AssignmentPattern') {
    collectBindingNames(pattern.left, names)
  } else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      collectBindingNames(
        property.type === 'RestElement' ? property.argument : property.value,
        names
      )
    }
  } else if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements) {
      collectBindingNames(element, names)
    }
  }
}

function visitChildren(node, visit) {
  for (const [key, child] of Object.entries(node)) {
    if (['parent', 'loc', 'range'].includes(key)) {
      continue
    }
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item?.type) {
          visit(item)
        }
      }
    } else if (child?.type) {
      visit(child)
    }
  }
}

function collectAssignedRoots(context, loop) {
  const assigned = new Set()
  const visit = (node) => {
    if (node.type === 'AssignmentExpression' && ASSIGNMENT_OPERATORS.has(node.operator)) {
      const root = rootReferenceText(context, node.left)
      if (root) {
        assigned.add(root)
      }
    }
    visitChildren(node, visit)
  }
  visit(loop.body)
  return assigned
}

function assignmentTargetOf(context, call) {
  let node = call
  let parent = node.parent
  while (
    parent &&
    (EXPRESSION_WRAPPERS.has(parent.type) ||
      (parent.type === 'ConditionalExpression' && parent.test !== node))
  ) {
    node = parent
    parent = parent.parent
  }
  if (parent?.type !== 'AssignmentExpression' || parent.operator !== '=' || parent.right !== node) {
    return null
  }
  return {
    text: normalizeReferenceText(sourceText(context, parent.left)),
    root: rootReferenceText(context, parent.left)
  }
}

function concatOperands(context, call) {
  return call.arguments[0].elements.filter(Boolean).map((element) => {
    const spread = element.type === 'SpreadElement'
    const expression = spread ? element.argument : element
    return {
      spread,
      text: normalizeReferenceText(sourceText(context, expression)),
      root: rootReferenceText(context, expression)
    }
  })
}

function isLoopCarried(root, loop, declarations) {
  const starts = declarations.get(root)
  return !starts || !starts.some((start) => isDeclaredInsideLoop(start, loop))
}

function quadraticAccumulator(context, call, loop, declarations, assignedRoots) {
  const operands = concatOperands(context, call)
  const target = assignmentTargetOf(context, call)
  const selfOperand = target
    ? operands.find((operand) => operand.text === target.text || operand.root === target.root)
    : null
  if (selfOperand && target.root && isLoopCarried(target.root, loop, declarations)) {
    return target.text
  }

  for (const operand of operands) {
    if (
      !operand.spread &&
      operand.root &&
      assignedRoots.has(operand.root) &&
      isLoopCarried(operand.root, loop, declarations)
    ) {
      return operand.root
    }
  }
  return null
}

function createRule(context) {
  const declarations = new Map()
  const assignedRootsByLoop = new WeakMap()
  const recordBindings = (pattern, owner) => {
    const names = []
    collectBindingNames(pattern, names)
    for (const name of names) {
      const starts = declarations.get(name) ?? []
      starts.push(nodeStart(owner))
      declarations.set(name, starts)
    }
  }
  const recordParameters = (node) => {
    for (const parameter of node.params) {
      recordBindings(parameter, parameter)
    }
  }

  return {
    VariableDeclarator(node) {
      recordBindings(node.id, node)
    },
    FunctionDeclaration: recordParameters,
    FunctionExpression: recordParameters,
    ArrowFunctionExpression: recordParameters,
    CatchClause(node) {
      recordBindings(node.param, node.param)
    },
    CallExpression(node) {
      if (!isBufferConcatCall(node)) {
        return
      }
      const loop = enclosingLoop(node)
      if (!loop) {
        return
      }
      let assignedRoots = assignedRootsByLoop.get(loop)
      if (!assignedRoots) {
        assignedRoots = collectAssignedRoots(context, loop)
        assignedRootsByLoop.set(loop, assignedRoots)
      }
      const accumulator = quadraticAccumulator(context, node, loop, declarations, assignedRoots)
      if (accumulator) {
        context.report({
          node,
          message: `Buffer.concat rebuilds loop-carried ${accumulator}; collect chunks and concatenate once after the loop.`
        })
      }
    }
  }
}

export default {
  meta: { name: 'quadratic-buffer-concat' },
  rules: {
    'no-loop-carried-concat': { create: createRule }
  }
}
