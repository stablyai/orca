// Guard intrinsic text-entry Enter handlers against CJK composition submission; capitalized Input/Textarea/ImeInput/ImeTextarea components already own the guard.

const KEY_HANDLER_PROPS = new Set([
  'onKeyDown',
  'onKeyDownCapture',
  'onKeyPress',
  'onKeyPressCapture'
])
const COMPOSITION_PROPS = new Set([
  'onCompositionStart',
  'onCompositionStartCapture',
  'onCompositionEnd',
  'onCompositionEndCapture'
])
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'date',
  'datetime-local',
  'file',
  'hidden',
  'image',
  'month',
  'radio',
  'range',
  'reset',
  'submit',
  'time',
  'week'
])
const KEY_EVENT_NAMES = new Set(['keydown', 'keypress'])

const ENTER_TEST_PATTERNS = [
  /(['"`])(?:Numpad)?Enter\1/,
  /\b(?:keyCode|which|charCode)\s*[!=]==?\s*13\b/,
  /\b13\s*[!=]==?\s*[\w$.?]*\b(?:keyCode|which|charCode)\b/
]
const IME_GUARD_PATTERN =
  /\b(?:isImeOwnedKeyboardEvent|isImeCompositionKeyDown|isComposing|ownsKeyDown|useImeTextFieldProps)\b|\b229\b/
const TEXT_ELEMENT_RECEIVER_PATTERN =
  /(?:^|[^A-Za-z])(?:input|textarea|editable)|Input|Textarea|TextArea|Editable/
const CREATE_TEXT_ELEMENT_PATTERN = /createElement\(\s*(['"`])(?:input|textarea)\1/

function jsxAttributeName(attribute) {
  if (attribute.type !== 'JSXAttribute') {
    return null
  }
  return attribute.name.type === 'JSXIdentifier' ? attribute.name.name : null
}

function jsxAttribute(node, name) {
  return node.attributes.find((attribute) => jsxAttributeName(attribute) === name) ?? null
}

function attributeLiteral(attribute) {
  const value = attribute?.value
  if (value?.type === 'Literal') {
    return value.value
  }
  if (value?.type === 'JSXExpressionContainer' && value.expression.type === 'Literal') {
    return value.expression.value
  }
  return undefined
}

function isTextEntryElement(node) {
  if (node.name.type !== 'JSXIdentifier') {
    return false
  }
  const tag = node.name.name
  if (tag === 'textarea') {
    return true
  }
  if (tag === 'input') {
    const type = attributeLiteral(jsxAttribute(node, 'type'))
    return typeof type !== 'string' || !NON_TEXT_INPUT_TYPES.has(type.toLowerCase())
  }
  const editable = jsxAttribute(node, 'contentEditable') ?? jsxAttribute(node, 'contenteditable')
  if (!editable) {
    return false
  }
  const value = editable.value === null ? true : attributeLiteral(editable)
  return value !== false && value !== 'false'
}

function testsEnter(text) {
  return ENTER_TEST_PATTERNS.some((pattern) => pattern.test(text))
}

function createImeEnterGuardRule(context) {
  const localFunctionTexts = new Map()
  const textElementNames = new Set()
  const candidates = []

  const text = (node) => context.sourceCode.getText(node)

  // Unions the handler with every same-file function it names, so a guard in a helper counts.
  const reachableText = (rootText) => {
    const seen = new Set()
    const pending = [rootText]
    const parts = []
    while (pending.length > 0) {
      const current = pending.pop()
      parts.push(current)
      for (const word of current.match(/[A-Za-z_$][\w$]*/g) ?? []) {
        if (!seen.has(word) && localFunctionTexts.has(word)) {
          seen.add(word)
          pending.push(...localFunctionTexts.get(word))
        }
      }
    }
    return parts.join('\n')
  }

  const rememberFunction = (name, node) => {
    const texts = localFunctionTexts.get(name) ?? []
    texts.push(text(node))
    localFunctionTexts.set(name, texts)
  }

  return {
    FunctionDeclaration(node) {
      if (node.id) {
        rememberFunction(node.id.name, node)
      }
    },
    VariableDeclarator(node) {
      if (node.id.type !== 'Identifier' || !node.init) {
        return
      }
      if (
        ['ArrowFunctionExpression', 'FunctionExpression', 'CallExpression'].includes(node.init.type)
      ) {
        rememberFunction(node.id.name, node.init)
      }
      if (CREATE_TEXT_ELEMENT_PATTERN.test(text(node.init))) {
        textElementNames.add(node.id.name)
      }
    },
    JSXOpeningElement(node) {
      if (!isTextEntryElement(node)) {
        return
      }
      if (node.attributes.some((attribute) => COMPOSITION_PROPS.has(jsxAttributeName(attribute)))) {
        return
      }
      for (const attribute of node.attributes) {
        if (
          KEY_HANDLER_PROPS.has(jsxAttributeName(attribute)) &&
          attribute.value?.type === 'JSXExpressionContainer'
        ) {
          candidates.push({ node: attribute, handler: attribute.value.expression })
        }
      }
    },
    CallExpression(node) {
      const callee = node.callee
      if (
        callee.type !== 'MemberExpression' ||
        callee.property.type !== 'Identifier' ||
        callee.property.name !== 'addEventListener'
      ) {
        return
      }
      const [eventName, listener] = node.arguments
      if (eventName?.type !== 'Literal' || !KEY_EVENT_NAMES.has(eventName.value) || !listener) {
        return
      }
      const receiver = text(callee.object)
      const rootName = receiver.match(/^[A-Za-z_$][\w$]*/)?.[0]
      if (TEXT_ELEMENT_RECEIVER_PATTERN.test(receiver) || textElementNames.has(rootName)) {
        candidates.push({ node, handler: listener })
      }
    },
    'Program:exit'() {
      for (const candidate of candidates) {
        const handler = candidate.handler
        let handlerText
        if (['ArrowFunctionExpression', 'FunctionExpression'].includes(handler.type)) {
          handlerText = text(handler)
        } else if (handler.type === 'Identifier' && localFunctionTexts.has(handler.name)) {
          handlerText = handler.name
        } else {
          // Props, hook results, and imports are judged where they are defined.
          continue
        }
        const reachable = reachableText(handlerText)
        if (testsEnter(reachable) && !IME_GUARD_PATTERN.test(reachable)) {
          context.report({
            node: candidate.node,
            message:
              'Enter handling on a raw text field must ignore IME composition: use ImeInput/ImeTextarea (or <Input>/<Textarea>), or guard with isImeOwnedKeyboardEvent from @/lib/ime-composition-keyboard-event.'
          })
        }
      }
    }
  }
}

export default {
  meta: { name: 'ime-enter-guard' },
  rules: {
    'require-ime-guard': { create: createImeEnterGuardRule }
  }
}
