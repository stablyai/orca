type McpToolArgType = 'string' | 'integer' | 'boolean'

export type McpToolArg = {
  name: string
  flag: string
  type: McpToolArgType
  description: string
  required?: boolean
  enum?: readonly string[]
  maximum?: number
  defaultValue?: number
}

export type McpToolDefinition = {
  name: string
  title: string
  description: string
  command: readonly string[]
  args: readonly McpToolArg[]
  readOnly: boolean
  // Can interrupt or overwrite existing work, not only add to it.
  destructive?: boolean
  // Blocking CLI calls get headroom over their own --timeout-ms.
  maxRuntimeMs?: number
}

export type McpToolSchema = {
  name: string
  title: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, Record<string, unknown>>
    required?: string[]
    additionalProperties: false
  }
  annotations: {
    title: string
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
    openWorldHint: false
  }
}

export class McpToolInputError extends Error {}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function describeMcpTool(tool: McpToolDefinition): McpToolSchema {
  const properties: Record<string, Record<string, unknown>> = {}
  for (const arg of tool.args) {
    properties[arg.name] = {
      type: arg.type,
      description: arg.description,
      ...(arg.enum ? { enum: arg.enum } : {}),
      ...(arg.type === 'integer' ? { minimum: 1 } : {}),
      ...(arg.maximum !== undefined ? { maximum: arg.maximum } : {}),
      ...(arg.defaultValue !== undefined ? { default: arg.defaultValue } : {})
    }
  }
  const required = tool.args.filter((arg) => arg.required).map((arg) => arg.name)
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false
    },
    annotations: {
      title: tool.title,
      readOnlyHint: tool.readOnly,
      destructiveHint: tool.destructive === true,
      idempotentHint: tool.readOnly,
      openWorldHint: false
    }
  }
}

/** Map validated tool input to `orca` argv; `--flag=value` keeps values starting with -- intact. */
export function buildMcpToolArgv(tool: McpToolDefinition, input: unknown): string[] {
  const record = input ?? {}
  if (!isJsonObject(record)) {
    throw new McpToolInputError('Tool arguments must be an object.')
  }
  const known = new Set(tool.args.map((arg) => arg.name))
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new McpToolInputError(`Unknown argument "${key}" for ${tool.name}.`)
    }
  }
  const argv = [...tool.command]
  for (const arg of tool.args) {
    const value = record[arg.name] ?? arg.defaultValue
    if (value === undefined || value === null) {
      if (arg.required) {
        throw new McpToolInputError(`${tool.name} requires "${arg.name}".`)
      }
      continue
    }
    argv.push(...flagTokens(tool, arg, value))
  }
  argv.push('--json')
  return argv
}

function flagTokens(tool: McpToolDefinition, arg: McpToolArg, value: unknown): string[] {
  const invalid = (expected: string): McpToolInputError =>
    new McpToolInputError(`${tool.name}: "${arg.name}" must be ${expected}.`)
  if (arg.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw invalid('a boolean')
    }
    return value ? [`--${arg.flag}`] : []
  }
  if (arg.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw invalid('a positive integer')
    }
    if (arg.maximum !== undefined && value > arg.maximum) {
      throw invalid(`at most ${arg.maximum}`)
    }
    return [`--${arg.flag}=${value}`]
  }
  if (typeof value !== 'string') {
    throw invalid('a string')
  }
  if (arg.enum && !arg.enum.includes(value)) {
    throw invalid(`one of ${arg.enum.join(', ')}`)
  }
  return [`--${arg.flag}=${value}`]
}
