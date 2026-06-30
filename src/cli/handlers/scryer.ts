import { createScryerEngine } from '../../main/scryer/engine'
import type {
  ScryerOperationContext,
  ScryerOperationId,
  ScryerOperationResult
} from '../../main/scryer/engine'
import type { CommandHandler, HandlerContext } from '../dispatch'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime-client'

function operationContext(ctx: HandlerContext): ScryerOperationContext {
  return {
    requestId: `cli-${Date.now()}`,
    transport: 'cli',
    caller: 'human',
    cwd: ctx.cwd,
    projectRoot: getOptionalStringFlag(ctx.flags, 'project'),
    leaseToken: getOptionalStringFlag(ctx.flags, 'lease-token'),
    output: { json: ctx.json }
  }
}

async function readStdin(): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
  }
  return chunks.join('')
}

async function readJsonInput(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const source = getOptionalStringFlag(ctx.flags, 'json-input')
  if (!source) {
    return {}
  }
  const raw = source === '-' ? await readStdin() : source
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch (error) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid --json-input: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  throw new RuntimeClientError('invalid_argument', '--json-input must decode to a JSON object')
}

function commaList(value: string | undefined): string[] | undefined {
  const items = value
    ?.split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return items && items.length > 0 ? items : undefined
}

function printEnvelope(result: ScryerOperationResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) {
      process.exitCode = 1
    }
    return
  }
  if (result.ok) {
    console.log(`${result.operationId} ok`)
  } else {
    console.error(`${result.error.code}: ${result.error.message}`)
    process.exitCode = 1
  }
}

async function execute(
  ctx: HandlerContext,
  operationId: ScryerOperationId,
  input: Record<string, unknown>
): Promise<void> {
  const result = await createScryerEngine().executeOperation(
    operationId,
    input,
    operationContext(ctx)
  )
  printEnvelope(result, ctx.json)
}

async function complexInput(ctx: HandlerContext): Promise<Record<string, unknown>> {
  return {
    ...(await readJsonInput(ctx)),
    ...(getOptionalStringFlag(ctx.flags, 'project')
      ? { project: getOptionalStringFlag(ctx.flags, 'project') }
      : {})
  }
}

export const SCRYER_HANDLERS: Record<string, CommandHandler> = {
  'scryer model read': async (ctx) => {
    const full = ctx.flags.get('full') === true
    const view = full ? 'full' : getOptionalStringFlag(ctx.flags, 'view')
    await execute(ctx, 'scryer.model.read', {
      project: getOptionalStringFlag(ctx.flags, 'project'),
      view,
      node: getOptionalStringFlag(ctx.flags, 'node'),
      layer: getOptionalStringFlag(ctx.flags, 'layer')
    })
  },
  'scryer model search': async (ctx) => {
    await execute(ctx, 'scryer.model.search', {
      project: getOptionalStringFlag(ctx.flags, 'project'),
      query: getRequiredStringFlag(ctx.flags, 'query'),
      kind: getOptionalStringFlag(ctx.flags, 'kind'),
      layer: getOptionalStringFlag(ctx.flags, 'layer')
    })
  },
  'scryer model query': async (ctx) => {
    await execute(ctx, 'scryer.model.query', await complexInput(ctx))
  },
  'scryer rules read': async (ctx) => {
    await execute(ctx, 'scryer.rules.read', {
      topic: getOptionalStringFlag(ctx.flags, 'topic')
    })
  },
  'scryer codebase read': async (ctx) => {
    await execute(ctx, 'scryer.codebase.read', {
      project: getOptionalStringFlag(ctx.flags, 'project'),
      path: getOptionalStringFlag(ctx.flags, 'path'),
      maxDepth: getOptionalNonNegativeIntegerFlag(ctx.flags, 'max-depth'),
      maxEntries: getOptionalPositiveIntegerFlag(ctx.flags, 'max-entries')
    })
  },
  'scryer model validate': async (ctx) => {
    await execute(ctx, 'scryer.model.validate', {
      project: getOptionalStringFlag(ctx.flags, 'project'),
      layer: getOptionalStringFlag(ctx.flags, 'layer')
    })
  },
  'scryer node update': async (ctx) => {
    await execute(ctx, 'scryer.node.update', await complexInput(ctx))
  },
  'scryer link add': async (ctx) => {
    const input = await complexInput(ctx)
    if (!input.links && getOptionalStringFlag(ctx.flags, 'src')) {
      input.links = [
        {
          src: getRequiredStringFlag(ctx.flags, 'src'),
          dst: getRequiredStringFlag(ctx.flags, 'dst'),
          label: getRequiredStringFlag(ctx.flags, 'label'),
          method: getOptionalStringFlag(ctx.flags, 'method')
        }
      ]
    }
    await execute(ctx, 'scryer.link.add', input)
  },
  'scryer link delete': async (ctx) => {
    const input = await complexInput(ctx)
    if (!input.link_ids) {
      input.link_ids = commaList(getOptionalStringFlag(ctx.flags, 'link-ids')) ?? []
    }
    await execute(ctx, 'scryer.link.delete', input)
  },
  'scryer plan pending': async (ctx) => {
    await execute(ctx, 'scryer.plan.pending', {
      project: getOptionalStringFlag(ctx.flags, 'project')
    })
  },
  'scryer plan fold': async (ctx) => {
    await execute(ctx, 'scryer.plan.fold', {
      ...(await complexInput(ctx)),
      node_id: getOptionalStringFlag(ctx.flags, 'node-id'),
      responsibility_ids: commaList(getOptionalStringFlag(ctx.flags, 'responsibility-ids')),
      property_labels: commaList(getOptionalStringFlag(ctx.flags, 'property-labels')),
      link_ids: commaList(getOptionalStringFlag(ctx.flags, 'link-ids')),
      all: ctx.flags.get('all') === true
    })
  }
}
