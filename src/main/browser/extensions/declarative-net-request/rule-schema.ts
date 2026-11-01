import {
  DNR_ACTION_TYPES,
  DNR_HEADER_OPERATIONS,
  DNR_REQUEST_METHODS,
  DNR_RESOURCE_TYPES,
  type DnrHeaderInfo,
  type DnrModifyHeaderInfo,
  type DnrQueryKeyValue,
  type DnrRedirect,
  type DnrRule,
  type DnrRuleAction,
  type DnrRuleCondition,
  type DnrUrlTransform
} from './rule-types'

// Mirrors the generated dnr_api::Rule::FromValue: wrong types and unknown enum values fail the
// rule, unknown keys are ignored. Error text follows json_schema_compiler's "Error at key" style.

class SchemaError extends Error {}

type Fields = Record<string, unknown>

function at<T>(key: string, read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof SchemaError) {
      throw new SchemaError(`Error at key '${key}': ${error.message}`)
    }
    throw error
  }
}

function asObject(value: unknown): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SchemaError('Expected dictionary.')
  }
  const fields: Fields = {}
  for (const [key, entry] of Object.entries(value)) {
    fields[key] = entry
  }
  return fields
}

function asInteger(value: unknown): number {
  // base::Value ints are 32-bit; JSON 1.0 cannot be told apart from 1 here.
  if (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) > 2 ** 31 - 1) {
    throw new SchemaError('Expected integer.')
  }
  return value
}

function asString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SchemaError('Expected string.')
  }
  return value
}

function asBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new SchemaError('Expected boolean.')
  }
  return value
}

function asEnum<T extends string>(values: readonly T[], value: unknown): T {
  const found = values.find((candidate) => candidate === value)
  if (found === undefined) {
    throw new SchemaError(`Value must be one of ${values.join(', ')}.`)
  }
  return found
}

function asList<T>(value: unknown, item: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) {
    throw new SchemaError('Expected list.')
  }
  return value.map((entry, index) => {
    try {
      return item(entry)
    } catch (error) {
      if (error instanceof SchemaError) {
        throw new SchemaError(`Error at index ${index}: ${error.message}`)
      }
      throw error
    }
  })
}

function optional<T>(fields: Fields, key: string, read: (value: unknown) => T): T | undefined {
  const value = fields[key]
  if (value === undefined) {
    return undefined
  }
  return at(key, () => read(value))
}

function required<T>(fields: Fields, key: string, read: (value: unknown) => T): T {
  if (fields[key] === undefined) {
    throw new SchemaError(`'${key}' is required.`)
  }
  return at(key, () => read(fields[key]))
}

const stringList = (value: unknown): string[] => asList(value, asString)
const integerList = (value: unknown): number[] => asList(value, asInteger)

function headerInfo(value: unknown): DnrHeaderInfo {
  const fields = asObject(value)
  return {
    header: required(fields, 'header', asString),
    values: optional(fields, 'values', stringList),
    excludedValues: optional(fields, 'excludedValues', stringList)
  }
}

function modifyHeaderInfo(value: unknown): DnrModifyHeaderInfo {
  const fields = asObject(value)
  return {
    header: required(fields, 'header', asString),
    operation: required(fields, 'operation', (v) => asEnum(DNR_HEADER_OPERATIONS, v)),
    value: optional(fields, 'value', asString),
    regexFilter: optional(fields, 'regexFilter', asString),
    regexSubstitution: optional(fields, 'regexSubstitution', asString),
    regexOptions: optional(fields, 'regexOptions', (v) => ({
      matchAll: optional(asObject(v), 'matchAll', asBoolean)
    }))
  }
}

function queryKeyValue(value: unknown): DnrQueryKeyValue {
  const fields = asObject(value)
  return {
    key: required(fields, 'key', asString),
    value: required(fields, 'value', asString),
    replaceOnly: optional(fields, 'replaceOnly', asBoolean)
  }
}

function transform(value: unknown): DnrUrlTransform {
  const fields = asObject(value)
  return {
    scheme: optional(fields, 'scheme', asString),
    host: optional(fields, 'host', asString),
    port: optional(fields, 'port', asString),
    path: optional(fields, 'path', asString),
    query: optional(fields, 'query', asString),
    queryTransform: optional(fields, 'queryTransform', (v) => {
      const query = asObject(v)
      return {
        removeParams: optional(query, 'removeParams', stringList),
        addOrReplaceParams: optional(query, 'addOrReplaceParams', (list) =>
          asList(list, queryKeyValue)
        )
      }
    }),
    fragment: optional(fields, 'fragment', asString),
    username: optional(fields, 'username', asString),
    password: optional(fields, 'password', asString)
  }
}

function redirect(value: unknown): DnrRedirect {
  const fields = asObject(value)
  return {
    extensionPath: optional(fields, 'extensionPath', asString),
    transform: optional(fields, 'transform', transform),
    url: optional(fields, 'url', asString),
    regexSubstitution: optional(fields, 'regexSubstitution', asString)
  }
}

function condition(value: unknown): DnrRuleCondition {
  const fields = asObject(value)
  const resourceTypes = (v: unknown): DnrRuleCondition['resourceTypes'] =>
    asList(v, (entry) => asEnum(DNR_RESOURCE_TYPES, entry))
  const methods = (v: unknown): DnrRuleCondition['requestMethods'] =>
    asList(v, (entry) => asEnum(DNR_REQUEST_METHODS, entry))
  return {
    urlFilter: optional(fields, 'urlFilter', asString),
    regexFilter: optional(fields, 'regexFilter', asString),
    isUrlFilterCaseSensitive: optional(fields, 'isUrlFilterCaseSensitive', asBoolean),
    initiatorDomains: optional(fields, 'initiatorDomains', stringList),
    excludedInitiatorDomains: optional(fields, 'excludedInitiatorDomains', stringList),
    requestDomains: optional(fields, 'requestDomains', stringList),
    excludedRequestDomains: optional(fields, 'excludedRequestDomains', stringList),
    topDomains: optional(fields, 'topDomains', stringList),
    excludedTopDomains: optional(fields, 'excludedTopDomains', stringList),
    domains: optional(fields, 'domains', stringList),
    excludedDomains: optional(fields, 'excludedDomains', stringList),
    resourceTypes: optional(fields, 'resourceTypes', resourceTypes),
    excludedResourceTypes: optional(fields, 'excludedResourceTypes', resourceTypes),
    requestMethods: optional(fields, 'requestMethods', methods),
    excludedRequestMethods: optional(fields, 'excludedRequestMethods', methods),
    domainType: optional(fields, 'domainType', (v) =>
      asEnum(['firstParty', 'thirdParty'] as const, v)
    ),
    tabIds: optional(fields, 'tabIds', integerList),
    excludedTabIds: optional(fields, 'excludedTabIds', integerList),
    responseHeaders: optional(fields, 'responseHeaders', (v) => asList(v, headerInfo)),
    excludedResponseHeaders: optional(fields, 'excludedResponseHeaders', (v) =>
      asList(v, headerInfo)
    )
  }
}

function action(value: unknown): DnrRuleAction {
  const fields = asObject(value)
  return {
    type: required(fields, 'type', (v) => asEnum(DNR_ACTION_TYPES, v)),
    redirect: optional(fields, 'redirect', redirect),
    requestHeaders: optional(fields, 'requestHeaders', (v) => asList(v, modifyHeaderInfo)),
    responseHeaders: optional(fields, 'responseHeaders', (v) => asList(v, modifyHeaderInfo))
  }
}

export type DnrRuleSchemaResult = { ok: true; rule: DnrRule } | { ok: false; message: string }

/** Reads one rule from extension-supplied JSON; never trusts the input's shape. */
export function readDnrRuleJson(value: unknown): DnrRuleSchemaResult {
  try {
    const fields = asObject(value)
    return {
      ok: true,
      rule: {
        id: required(fields, 'id', asInteger),
        priority: optional(fields, 'priority', asInteger),
        condition: required(fields, 'condition', condition),
        action: required(fields, 'action', action)
      }
    }
  } catch (error) {
    if (error instanceof SchemaError) {
      return { ok: false, message: error.message }
    }
    throw error
  }
}
