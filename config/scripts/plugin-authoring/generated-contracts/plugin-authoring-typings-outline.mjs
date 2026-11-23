// Reads the author typings (`resources/plugins/**/*.d.ts`) into compact one-line outlines.
import ts from 'typescript-api'

const printer = ts.createPrinter({ removeComments: true })
const MAX_PARAMS_TEXT = 100

function oneLine(text) {
  return text.replace(/\s+/g, ' ').replace(/; \}/g, ' }').replace(/;\s*$/u, '').trim()
}

function summary(node) {
  const doc = ts.getJSDocCommentsAndTags(node).find((entry) => ts.isJSDoc(entry))
  return doc ? oneLine(ts.getTextOfJSDocComment(doc.comment) ?? '') : ''
}

/** Parses `declare module '<name>' { ... }` (every block of it, as split files merge) and indexes
 *  its declarations by name. */
export function readTypingsModule(text, fileName, moduleName) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  const blocks = source.statements.filter(
    (statement) =>
      ts.isModuleDeclaration(statement) &&
      statement.name.text === moduleName &&
      statement.body &&
      ts.isModuleBlock(statement.body)
  )
  if (blocks.length === 0) {
    throw new Error(`${fileName} declares no module ${moduleName}`)
  }
  const print = (node) => oneLine(printer.printNode(ts.EmitHint.Unspecified, node, source))
  const types = new Map()
  const values = new Map()
  const functions = []
  for (const statement of blocks.flatMap((block) => block.body.statements)) {
    if (ts.isTypeAliasDeclaration(statement)) {
      types.set(statement.name.text, statement)
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      const text = print(statement).replace(/^export (declare )?/u, '')
      functions.push({ name: statement.name.text, text, summary: summary(statement) })
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        values.set(declaration.name.getText(source), {
          type: declaration.type,
          summary: summary(statement)
        })
      }
    }
  }
  const requireType = (name) => {
    const alias = types.get(name)
    if (!alias) {
      throw new Error(`${fileName} module ${moduleName} has no type ${name}`)
    }
    return alias
  }
  const memberLine = (member) => {
    if (ts.isMethodSignature(member)) {
      const params = member.parameters.map(print).join(', ')
      const names = member.parameters
        .map((param) => `${param.dotDotDotToken ? '...' : ''}${param.name.getText(source)}`)
        .join(', ')
      return `${member.name.getText(source)}(${params.length > MAX_PARAMS_TEXT ? names : params})`
    }
    return print(member).replace(/^readonly /u, '')
  }
  /** Members of a type literal; with `flatten`, nested object members become `outer.inner`. */
  const members = (typeNode, { prefix = '', flatten = true, inherited = '' } = {}) => {
    if (!typeNode || !ts.isTypeLiteralNode(typeNode)) {
      return []
    }
    return typeNode.members.flatMap((member) => {
      const name = member.name?.getText(source)
      const own = summary(member)
      const nested = ts.isPropertySignature(member) && member.type
      if (flatten && nested && ts.isTypeLiteralNode(member.type)) {
        return members(member.type, { prefix: `${prefix}${name}.`, inherited: own || inherited })
      }
      return [{ name, text: `${prefix}${memberLine(member)}`, summary: own || inherited }]
    })
  }
  const typeName = (alias) =>
    `${alias.name.text}${alias.typeParameters ? `<${alias.typeParameters.map(print).join(', ')}>` : ''}`
  return {
    /** `type X = A & { ... }`: the members of every literal part. */
    literalMembers(name, options) {
      const node = requireType(name).type
      const parts = ts.isIntersectionTypeNode(node) ? node.types : [node]
      return parts.flatMap((part) => members(part, options))
    },
    typeText(name) {
      return print(requireType(name).type)
    },
    /** `Name<T> = type`. */
    typeDeclaration(name) {
      const alias = requireType(name)
      return `${typeName(alias)} = ${print(alias.type)}`
    },
    /** String-literal members of a union alias, in order. */
    unionLiterals(name) {
      const node = requireType(name).type
      if (!ts.isUnionTypeNode(node)) {
        throw new Error(`${fileName} type ${name} is not a union`)
      }
      return node.types.map((part) => part.literal.text)
    },
    typeSummary(name) {
      return summary(requireType(name))
    },
    functions,
    /** Exported consts other than components: `name: type` or their flattened members. */
    value(name) {
      const value = values.get(name)
      if (!value) {
        throw new Error(`${fileName} module ${moduleName} has no value ${name}`)
      }
      const flattened = members(value.type, { prefix: `${name}.`, inherited: value.summary })
      // A literal of plain undocumented fields reads best as one line.
      const plain =
        ts.isTypeLiteralNode(value.type) &&
        value.type.members.every((member) => ts.isPropertySignature(member) && !summary(member))
      return flattened.length > 0 && !plain
        ? flattened
        : [{ name, text: `${name}: ${print(value.type)}`, summary: value.summary }]
    },
    valueNames: [...values.keys()],
    componentProps(name) {
      const type = values.get(name)?.type
      return type &&
        ts.isTypeReferenceNode(type) &&
        type.typeName.getText(source) === 'OrcaComponent'
        ? type.typeArguments?.[0]?.getText(source)
        : undefined
    }
  }
}
