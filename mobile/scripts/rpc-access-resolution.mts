import ts from 'typescript'
export type RpcAccessKind = 'request' | 'subscribe'
export function createRpcAccessResolver(program: ts.Program, paths: string[]) {
  const checker = program.getTypeChecker()
  function entryKind(name: string | undefined): RpcAccessKind | undefined {
    return name === 'sendRequest' ? 'request' : name === 'subscribe' ? 'subscribe' : undefined
  }
  function resolveKind(node: ts.Node, seen = new Set<ts.Node>()): RpcAccessKind | undefined {
    if (seen.has(node)) {
      return
    }
    seen.add(node)
    if (ts.isPropertyAccessExpression(node)) {
      return entryKind(node.name.text)
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      const keyType = checker.getTypeAtLocation(node.argumentExpression)
      if (keyType.isStringLiteral()) {
        return entryKind(keyType.value)
      }
      if (checker.getTypeAtLocation(node.expression).getProperty('sendRequest')) {
        return 'request'
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'bind'
    ) {
      return resolveKind(node.expression.expression, seen)
    }
    if (!ts.isIdentifier(node)) {
      return
    }
    const direct = entryKind(node.text)
    if (direct) {
      return direct
    }
    let symbol = checker.getSymbolAtLocation(node)
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol)
    }
    for (const declaration of symbol?.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const kind = resolveKind(declaration.initializer, seen)
        if (kind) {
          return kind
        }
      }
      if (ts.isBindingElement(declaration)) {
        return entryKind(
          (declaration.propertyName ?? declaration.name).getText().replace(/['"]/g, '')
        )
      }
    }
  }
  const calls: ts.CallExpression[] = []
  for (const file of paths) {
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        calls.push(node)
      }
      ts.forEachChild(node, walk)
    }
    walk(program.getSourceFile(file)!)
  }
  function callers(owner: ts.SignatureDeclaration): ts.CallExpression[] {
    const direct = calls.filter((call) => checker.getResolvedSignature(call)?.declaration === owner)
    if (direct.length) {
      return direct
    }
    if (
      owner.getSourceFile().fileName.endsWith('use-mobile-structured-agent-session.ts') &&
      owner.parameters[0]?.name.getText() === 'method'
    ) {
      return calls.filter((call) => {
        const declaration = checker.getResolvedSignature(call)?.declaration
        return (
          declaration?.parent &&
          ts.isTypeAliasDeclaration(declaration.parent) &&
          declaration.parent.name.text === 'StructuredAgentSessionMutate'
        )
      })
    }
    return []
  }
  function methods(node: ts.Expression | undefined, seen = new Set<ts.Node>()): string[] {
    if (!node) {
      return []
    }
    if (ts.isStringLiteralLike(node)) {
      return [node.text]
    }
    if (seen.has(node)) {
      return []
    }
    seen = new Set(seen).add(node)
    const type = checker.getTypeAtLocation(node)
    const types = type.isUnion() ? type.types : [type]
    if (types.every((item) => item.isStringLiteral())) {
      return types.map((item) => (item as ts.StringLiteralType).value).sort()
    }
    const symbol = checker.getSymbolAtLocation(node)
    for (const declaration of symbol?.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return methods(declaration.initializer, seen)
      }
      if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
        const binding = declaration.parent.parent
        if (ts.isVariableDeclaration(binding) && binding.initializer) {
          const key = (declaration.propertyName ?? declaration.name).getText()
          const target = checker.getSymbolAtLocation(binding.initializer)
          for (const param of target?.declarations ?? []) {
            if (!ts.isParameter(param) || !ts.isFunctionLike(param.parent)) {
              continue
            }
            const index = param.parent.parameters.indexOf(param)
            const values = callers(param.parent)
              .map((call) => call.arguments[index])
              .map((arg) => {
                if (!arg || !ts.isObjectLiteralExpression(arg)) {
                  return []
                }
                return arg.properties
                  .filter((property) => property.name?.getText() === key)
                  .flatMap((property) =>
                    ts.isPropertyAssignment(property)
                      ? methods(property.initializer, seen)
                      : ts.isShorthandPropertyAssignment(property)
                        ? methods(property.name, seen)
                        : []
                  )
              })
            if (values.length && values.every((value) => value.length)) {
              return [...new Set(values.flat())].sort()
            }
          }
        }
      }
      if (ts.isShorthandPropertyAssignment(declaration)) {
        const value = checker.getShorthandAssignmentValueSymbol(declaration)
        for (const item of value?.declarations ?? []) {
          if (ts.isParameter(item)) {
            const owner = item.parent
            if (ts.isFunctionLike(owner)) {
              const index = owner.parameters.indexOf(item)
              const values = callers(owner).map((call) => methods(call.arguments[index], seen))
              if (values.length && values.every((value) => value.length)) {
                return [...new Set(values.flat())].sort()
              }
            }
          }
        }
      }
      if (ts.isParameter(declaration)) {
        const owner = declaration.parent
        if (!ts.isFunctionLike(owner)) {
          continue
        }
        const index = owner.parameters.indexOf(declaration)
        const callerArgs = callers(owner).map((call) => call.arguments[index])
        const resolved = callerArgs.map((arg) => methods(arg, seen))
        if (resolved.length && resolved.every((values) => values.length)) {
          return [...new Set(resolved.flat())].sort()
        }
      }
    }
    return []
  }
  return { entryKind, resolveKind, methods, calls }
}
