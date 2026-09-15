import ts from 'typescript'
export type RpcAccessKind = 'request' | 'subscribe' | 'unsubscribe'
export function unsubscribeFrameMethod(node: ts.Node): string | undefined {
  if (
    ts.isPropertyAssignment(node) &&
    node.name.getText().replace(/['"]/g, '') === 'method' &&
    ts.isStringLiteralLike(node.initializer) &&
    node.initializer.text.endsWith('.unsubscribe')
  ) {
    return node.initializer.text
  }
}
export function createRpcAccessResolver(program: ts.Program, paths: string[]) {
  const checker = program.getTypeChecker()
  function entryKind(name: string | undefined): RpcAccessKind | undefined {
    return name === 'sendRequest'
      ? 'request'
      : name === 'subscribe'
        ? 'subscribe'
        : name === 'sendUnsubscribe'
          ? 'unsubscribe'
          : undefined
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
  const references = new Map<ts.Symbol, ts.Identifier[]>()
  /** Symbol of the binding a function value is stored in, mapped to every function-type alias it
   *  is contextually assigned to. A call through such an alias resolves to the alias signature,
   *  not to the function, so without this the caller set is silently partial. */
  const aliasCarriers = new Map<ts.Symbol, Set<ts.Declaration>>()
  function recordAliasCarrier(symbol: ts.Symbol | undefined, context: ts.Type | undefined): void {
    const alias = context?.aliasSymbol?.declarations?.[0]
    if (!alias || !symbol || !ts.isTypeAliasDeclaration(alias)) {
      return
    }
    const carried = aliasCarriers.get(symbol) ?? new Set<ts.Declaration>()
    carried.add(alias)
    aliasCarriers.set(symbol, carried)
  }
  for (const file of paths) {
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        calls.push(node)
      }
      if (ts.isIdentifier(node)) {
        let symbol = ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : checker.getSymbolAtLocation(node)
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
          symbol = checker.getAliasedSymbol(symbol)
        }
        if (symbol) {
          const uses = references.get(symbol) ?? []
          uses.push(node)
          references.set(symbol, uses)
        }
      }
      if (ts.isShorthandPropertyAssignment(node)) {
        // The symbol at a shorthand name is the object's property, not the value it carries.
        recordAliasCarrier(
          checker.getShorthandAssignmentValueSymbol(node),
          checker.getContextualType(node.name)
        )
      } else if (ts.isIdentifier(node)) {
        recordAliasCarrier(checker.getSymbolAtLocation(node), checker.getContextualType(node))
      }
      ts.forEachChild(node, walk)
    }
    walk(program.getSourceFile(file)!)
  }
  /** The binding a function expression is assigned to, through wrappers such as `useCallback`. */
  function ownerBinding(owner: ts.SignatureDeclaration): ts.Symbol | undefined {
    let node: ts.Node = owner
    while (
      node.parent &&
      (ts.isCallExpression(node.parent) ||
        ts.isParenthesizedExpression(node.parent) ||
        ts.isAsExpression(node.parent))
    ) {
      node = node.parent
    }
    const declaration = node.parent
    if (declaration && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
      return checker.getSymbolAtLocation(declaration.name)
    }
    return owner.name && ts.isIdentifier(owner.name)
      ? checker.getSymbolAtLocation(owner.name)
      : undefined
  }
  function escapes(
    binding: ts.Symbol,
    enumerated: Set<ts.CallExpression>,
    seen = new Set<ts.Symbol>()
  ): boolean {
    if (seen.has(binding)) {
      return false
    }
    seen.add(binding)
    return (references.get(binding) ?? []).some((use) => {
      const parent = use.parent
      if (
        (ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent)) &&
        parent.name === use
      ) {
        return false
      }
      if (ts.isImportSpecifier(parent)) {
        return false
      }
      if (ts.isCallExpression(parent) && parent.expression === use) {
        return !enumerated.has(parent)
      }
      if (ts.isVariableDeclaration(parent) && parent.initializer === use) {
        const alias = checker.getSymbolAtLocation(parent.name)
        return !alias || escapes(alias, enumerated, seen)
      }
      // Only direct calls and fully enumerated local aliases prove a complete caller set.
      return true
    })
  }
  function callers(owner: ts.SignatureDeclaration): ts.CallExpression[] {
    const binding = ownerBinding(owner)
    if (!binding) {
      return []
    }
    const direct = calls.filter((call) => checker.getResolvedSignature(call)?.declaration === owner)
    const aliases = binding && aliasCarriers.get(binding)
    const aliased = calls.filter((call) => {
      const declaration = checker.getResolvedSignature(call)?.declaration
      return Boolean(declaration?.parent && aliases?.has(declaration.parent))
    })
    const enumerated = new Set([...direct, ...aliased])
    return escapes(binding, enumerated) ? [] : [...enumerated]
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
