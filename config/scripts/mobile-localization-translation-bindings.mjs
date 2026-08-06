// TypeScript 7 is a native CLI; AST consumers still need the legacy JavaScript API.
import ts from 'typescript-api'

import { collectSourceBindings } from './mobile-localization-source-bindings.mjs'
import { createMobileLocalizationValueFlow } from './mobile-localization-value-flow.mjs'

const MOBILE_I18N_MODULE_RE = /(?:^|\/)mobile-i18n$/
const TRANSLATOR_PREFIX = 'translator:'
const PROPERTY_RESOLUTION_KEYS = new WeakMap()

function emptyResolution(unknown = false) {
  return { descriptors: new Set(), unknown }
}

function mergeResolutions(resolutions) {
  const merged = emptyResolution()
  for (const resolution of resolutions) {
    resolution.descriptors.forEach((descriptor) => merged.descriptors.add(descriptor))
    merged.unknown ||= resolution.unknown
  }
  return merged
}

function memberParts(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return { object: node.expression, propertyName: node.name.text }
  }
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    return { object: node.expression, propertyName: node.argumentExpression.text }
  }
  return undefined
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text
  }
  return undefined
}

function propertyResolutionKey(object, propertyName, bindings) {
  const expression = bindings.valueFlow.unwrapExpression(object)
  const subject = ts.isIdentifier(expression)
    ? (bindings.resolveBinding(expression) ?? expression)
    : expression
  const keys = PROPERTY_RESOLUTION_KEYS.get(subject) ?? new Map()
  if (!PROPERTY_RESOLUTION_KEYS.has(subject)) {
    PROPERTY_RESOLUTION_KEYS.set(subject, keys)
  }
  const key = keys.get(propertyName) ?? {}
  keys.set(propertyName, key)
  return key
}

function builtInMemberResolution(base, propertyName) {
  const resolutions = []
  for (const descriptor of base.descriptors) {
    if (descriptor === 'namespace') {
      const member = {
        createMobileTranslator: 'factory',
        mobileI18n: 'instance',
        t: `${TRANSLATOR_PREFIX}`
      }[propertyName]
      resolutions.push(
        member ? { descriptors: new Set([member]), unknown: false } : emptyResolution(true)
      )
    } else if (descriptor === 'instance') {
      const member = {
        getFixedT: 'fixed-factory',
        t: `${TRANSLATOR_PREFIX}`
      }[propertyName]
      resolutions.push(
        member ? { descriptors: new Set([member]), unknown: false } : emptyResolution(true)
      )
    } else {
      resolutions.push(emptyResolution(true))
    }
  }
  if (base.unknown) {
    resolutions.push(emptyResolution(true))
  }
  return mergeResolutions(resolutions)
}

function propertyResolution(object, propertyName, use, bindings, mode, seen) {
  const key = propertyResolutionKey(object, propertyName, bindings)
  if (seen.has(key)) {
    return emptyResolution(true)
  }
  const nextSeen = new Set(seen).add(key)
  const propertyValues = bindings.valueFlow.propertyValues(
    object,
    propertyName,
    use,
    new Set(nextSeen),
    mode === 'all'
  )
  if (propertyValues?.length) {
    return mergeResolutions(
      propertyValues.map((value) => expressionResolution(value, value, bindings, mode, nextSeen))
    )
  }
  const spreadResolution = spreadPropertyResolution(
    object,
    propertyName,
    use,
    bindings,
    mode,
    nextSeen
  )
  if (spreadResolution) {
    return spreadResolution
  }
  const base = expressionResolution(object, use, bindings, mode, nextSeen)
  return builtInMemberResolution(base, propertyName)
}

function spreadPropertyResolution(object, propertyName, use, bindings, mode, seen) {
  const expression = bindings.valueFlow.unwrapExpression(object)
  const values = ts.isIdentifier(expression)
    ? mode === 'all'
      ? bindings.valueFlow.allValueExpressions(expression, use, new Set(seen))
      : bindings.valueFlow.valueExpressions(expression, use, new Set(seen))
    : [expression]
  const resolutions = []
  for (const value of values ?? []) {
    const objectValue = bindings.valueFlow.unwrapExpression(value)
    if (!ts.isObjectLiteralExpression(objectValue)) {
      continue
    }
    for (const property of objectValue.properties.toReversed()) {
      if (ts.isSpreadAssignment(property)) {
        resolutions.push(
          propertyResolution(
            property.expression,
            propertyName,
            property.expression,
            bindings,
            mode,
            seen
          )
        )
        break
      }
      const name = propertyNameText(property.name)
      if (name === undefined) {
        resolutions.push(emptyResolution(true))
        break
      }
      if (name === propertyName) {
        break
      }
    }
  }
  return resolutions.length > 0 ? mergeResolutions(resolutions) : undefined
}

function propertyPathResolution(object, propertyPath, use, bindings, mode, seen) {
  if (propertyPath.length === 1) {
    return propertyResolution(object, propertyPath[0], use, bindings, mode, seen)
  }
  const values = bindings.valueFlow.propertyValues(
    object,
    propertyPath[0],
    use,
    new Set(seen),
    mode === 'all'
  )
  if (!values?.length) {
    return emptyResolution(true)
  }
  return mergeResolutions(
    values.map((value) =>
      propertyPathResolution(value, propertyPath.slice(1), value, bindings, mode, seen)
    )
  )
}

function writeSourceResolution(source, bindings, mode, seen) {
  if (!source.propertyPath) {
    return expressionResolution(source.expression, source.node, bindings, mode, seen)
  }
  const values = bindings.valueFlow.propertyPathValues(
    source.expression,
    source.propertyPath,
    source.node,
    new Set(seen),
    mode === 'all'
  )
  if (values?.length) {
    return mergeResolutions(
      values.map((value) => expressionResolution(value, value, bindings, mode, seen))
    )
  }
  if (values && source.defaultExpression) {
    return expressionResolution(
      source.defaultExpression,
      source.defaultExpression,
      bindings,
      mode,
      seen
    )
  }
  return propertyPathResolution(
    source.expression,
    source.propertyPath,
    source.node,
    bindings,
    mode,
    seen
  )
}

function expressionResolution(node, use, bindings, mode, seen = new Set()) {
  const expression = bindings.valueFlow.unwrapExpression(node)
  if (ts.isIdentifier(expression)) {
    const binding = bindings.resolveBinding(expression)
    const stableDescriptor = binding ? bindings.stableDescriptors?.get(binding) : undefined
    if (
      stableDescriptor &&
      (mode === 'all' ||
        stableDescriptor.writes.every((write) => bindings.valueFlow.writeReachesUse(write, use)))
    ) {
      return { descriptors: new Set([stableDescriptor.descriptor]), unknown: false }
    }
    const potentialDescriptors = binding ? bindings.potentialDescriptors?.get(binding) : undefined
    if (mode === 'all' && potentialDescriptors?.size) {
      return { descriptors: new Set(potentialDescriptors), unknown: false }
    }
    if (!binding || seen.has(binding)) {
      return emptyResolution(true)
    }
    if (mode === 'all') {
      const cached = bindings.allResolutionCache?.get(binding)
      if (cached) {
        return cached
      }
      if (bindings.allResolutionInProgress?.has(binding)) {
        return emptyResolution(true)
      }
      bindings.allResolutionInProgress ??= new Set()
      bindings.allResolutionInProgress.add(binding)
    }
    const nextSeen = new Set(seen).add(binding)
    const sources = bindings.valueFlow.valueSources(expression, use, mode === 'all')
    if (sources.length === 0) {
      bindings.allResolutionInProgress?.delete(binding)
      return emptyResolution(true)
    }
    const resolution = mergeResolutions(
      sources.map((source) => writeSourceResolution(source, bindings, mode, nextSeen))
    )
    if (mode === 'all') {
      bindings.allResolutionInProgress.delete(binding)
      bindings.allResolutionCache ??= new Map()
      bindings.allResolutionCache.set(binding, resolution)
    }
    return resolution
  }

  const member = memberParts(expression)
  if (member) {
    return propertyResolution(member.object, member.propertyName, use, bindings, mode, seen)
  }

  if (ts.isCallExpression(expression)) {
    const callee = expressionResolution(expression.expression, expression, bindings, mode, seen)
    const resolutions = []
    for (const descriptor of callee.descriptors) {
      if (
        descriptor === 'factory' &&
        expression.arguments.length === 1 &&
        ts.isStringLiteralLike(expression.arguments[0])
      ) {
        resolutions.push({
          descriptors: new Set([`${TRANSLATOR_PREFIX}${expression.arguments[0].text}`]),
          unknown: false
        })
      } else if (
        descriptor === 'fixed-factory' &&
        expression.arguments.length === 1 &&
        ts.isStringLiteralLike(expression.arguments[0]) &&
        expression.arguments[0].text === 'en'
      ) {
        resolutions.push({ descriptors: new Set([TRANSLATOR_PREFIX]), unknown: false })
      } else {
        resolutions.push(emptyResolution(true))
      }
    }
    if (callee.unknown) {
      resolutions.push(emptyResolution(true))
    }
    return mergeResolutions(resolutions)
  }

  return emptyResolution(true)
}

function translationPrefix(node, use, bindings, mode = 'reaching') {
  const resolution = expressionResolution(node, use, bindings, mode)
  const prefixes = [...resolution.descriptors]
    .filter((descriptor) => descriptor.startsWith(TRANSLATOR_PREFIX))
    .map((descriptor) => descriptor.slice(TRANSLATOR_PREFIX.length))
  if (
    resolution.unknown ||
    prefixes.length === 0 ||
    prefixes.length !== resolution.descriptors.size ||
    new Set(prefixes).size !== 1
  ) {
    return undefined
  }
  return prefixes[0]
}

function collectStableDescriptors(valueFlow, rootDescriptors, resolveBinding) {
  const descriptors = new Map(
    [...rootDescriptors].map(([binding, descriptor]) => [binding, { descriptor, writes: [] }])
  )
  const dependents = new Map()
  for (const [binding] of valueFlow.bindingWrites()) {
    const write = valueFlow.stableBindingWrite(binding)
    if (!write || write.propertyPath) {
      continue
    }
    const source = valueFlow.unwrapExpression(write.expression)
    if (!ts.isIdentifier(source)) {
      continue
    }
    const sourceBinding = resolveBinding(source)
    if (!sourceBinding) {
      continue
    }
    const entries = dependents.get(sourceBinding) ?? []
    entries.push({
      binding,
      write,
      always: valueFlow.isImmutableBinding(binding)
    })
    dependents.set(sourceBinding, entries)
  }
  const queue = [...descriptors.keys()]
  for (let index = 0; index < queue.length; index += 1) {
    const source = queue[index]
    const sourceDescriptor = descriptors.get(source)
    for (const target of dependents.get(source) ?? []) {
      if (!descriptors.has(target.binding)) {
        descriptors.set(target.binding, {
          descriptor: sourceDescriptor.descriptor,
          writes: target.always
            ? sourceDescriptor.writes
            : [...sourceDescriptor.writes, target.write]
        })
        queue.push(target.binding)
      }
    }
  }
  return descriptors
}

function collectPotentialDescriptors(valueFlow, rootDescriptors, resolveBinding) {
  const descriptors = new Map(
    [...rootDescriptors].map(([binding, descriptor]) => [binding, new Set([descriptor])])
  )
  const dependents = new Map()
  for (const [binding, writes] of valueFlow.bindingWrites()) {
    for (const write of writes) {
      if (write.propertyPath) {
        continue
      }
      const source = valueFlow.unwrapExpression(write.expression)
      const sourceBinding = ts.isIdentifier(source) ? resolveBinding(source) : undefined
      if (!sourceBinding) {
        continue
      }
      const entries = dependents.get(sourceBinding) ?? new Set()
      entries.add(binding)
      dependents.set(sourceBinding, entries)
    }
  }
  const queue = [...descriptors.keys()]
  for (let index = 0; index < queue.length; index += 1) {
    const source = queue[index]
    for (const target of dependents.get(source) ?? []) {
      const targetDescriptors = descriptors.get(target) ?? new Set()
      const previousSize = targetDescriptors.size
      descriptors.get(source).forEach((descriptor) => targetDescriptors.add(descriptor))
      descriptors.set(target, targetDescriptors)
      if (targetDescriptors.size > previousSize) {
        queue.push(target)
      }
    }
  }
  return descriptors
}

function bindingName(binding) {
  return binding.name && ts.isIdentifier(binding.name) ? binding.name.text : undefined
}

function collectPotentialBindingNames(bindings) {
  for (const [binding, writes] of bindings.valueFlow.bindingWrites()) {
    const name = bindingName(binding)
    if (!name) {
      continue
    }
    const resolution = mergeResolutions(
      writes.map((write) => writeSourceResolution(write, bindings, 'all', new Set([binding])))
    )
    if ([...resolution.descriptors].some((value) => value.startsWith(TRANSLATOR_PREFIX))) {
      bindings.translatorNames.add(name)
    }
    if (resolution.descriptors.has('namespace')) {
      bindings.namespaceNames.add(name)
    }
    if (resolution.descriptors.has('instance')) {
      bindings.instanceNames.add(name)
    }
  }
}

export function collectMobileTranslationBindings(sourceFile) {
  const sourceBindings = collectSourceBindings(sourceFile)
  const rootDescriptors = new Map()
  const translatorBindings = new Set()
  const factoryBindings = new Set()
  const instanceBindings = new Set()
  const namespaceBindings = new Set()
  const translatorNames = new Set()
  const instanceNames = new Set()
  const namespaceNames = new Set()

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !MOBILE_I18N_MODULE_RE.test(statement.moduleSpecifier.text)
    ) {
      continue
    }
    const namedBindings = statement.importClause?.namedBindings
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      rootDescriptors.set(namedBindings, 'namespace')
      namespaceBindings.add(namedBindings)
      namespaceNames.add(namedBindings.name.text)
      continue
    }
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue
    }
    for (const element of namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text
      if (importedName === 't') {
        rootDescriptors.set(element, TRANSLATOR_PREFIX)
        translatorBindings.add(element)
        translatorNames.add(element.name.text)
      } else if (importedName === 'createMobileTranslator') {
        rootDescriptors.set(element, 'factory')
        factoryBindings.add(element)
      } else if (importedName === 'mobileI18n') {
        rootDescriptors.set(element, 'instance')
        instanceBindings.add(element)
        instanceNames.add(element.name.text)
      }
    }
  }

  const bindings = {
    factoryBindings,
    fixedFactoryBindings: new Set(),
    fixedTranslatorBindings: new Set(),
    fixedTranslatorNames: new Set(),
    instanceBindings,
    instanceNames,
    namespaceBindings,
    namespaceNames,
    prefixedTranslatorBindings: new Map(),
    prefixedTranslatorNames: new Map(),
    resolveBinding: sourceBindings.resolveBinding,
    rootDescriptors,
    translatorBindings,
    translatorNames
  }
  bindings.valueFlow = createMobileLocalizationValueFlow(sourceFile, bindings)
  bindings.stableDescriptors = collectStableDescriptors(
    bindings.valueFlow,
    rootDescriptors,
    bindings.resolveBinding
  )
  bindings.potentialDescriptors = collectPotentialDescriptors(
    bindings.valueFlow,
    rootDescriptors,
    bindings.resolveBinding
  )
  collectPotentialBindingNames(bindings)
  return bindings
}

export function mobileTranslationCallPrefix(call, _sourceFile, bindings) {
  return translationPrefix(call.expression, call, bindings)
}

export function isMobileTranslationCall(call, sourceFile, bindings) {
  return mobileTranslationCallPrefix(call, sourceFile, bindings) !== undefined
}

export function isPotentialMobileTranslationCall(call, bindings) {
  const resolution = expressionResolution(call.expression, call, bindings, 'all')
  return [...resolution.descriptors].some((descriptor) => descriptor.startsWith(TRANSLATOR_PREFIX))
}
