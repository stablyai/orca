import { z } from 'zod'
import { collectSalvageDrops } from '../../../src/shared/zod-salvage'
import type { RpcCompatibleReader, RpcDecodeIssue } from './rpc-operation-contract'

const MAX_REPORTED_DECODE_ISSUES = 20

/** A reader that names the semantic variant it decodes, so a combinator can tag its issues. */
export type NamedRpcResultReader<Variant extends string, Value> = RpcCompatibleReader<
  unknown,
  Variant,
  Value
> & { readonly variant: Variant }

/** Builds a compatible reader for one semantic variant of a reply payload. */
export function rpcResultVariant<Variant extends string, Schema extends z.ZodType>(
  variant: Variant,
  schema: Schema
): NamedRpcResultReader<Variant, z.output<Schema>> {
  const read: RpcCompatibleReader<unknown, Variant, z.output<Schema>> = (raw) => {
    try {
      // Why: zod-salvage holds module-level collector state and wraps a *synchronous*
      // parse only; safeParse throws on an async schema, which reads as incompatible.
      const parsed = collectSalvageDrops(() => schema.safeParse(raw))
      if (!parsed.value.success) {
        return { compatible: false, issues: decodeIssues(parsed.value.error) }
      }
      return {
        compatible: true,
        variant,
        value: parsed.value.data as z.output<Schema>,
        salvage: { droppedPaths: parsed.droppedPaths, droppedCount: parsed.droppedCount }
      }
    } catch (error) {
      return { compatible: false, issues: [{ path: '', message: describeThrow(error) }] }
    }
  }
  return Object.assign(read, { variant })
}

/** Tries each variant in declared order and takes the first that reads. */
export function rpcResultVariants<Variant extends string, Value>(
  readers: readonly NamedRpcResultReader<Variant, Value>[]
): RpcCompatibleReader<unknown, Variant, Value> {
  return (raw) => {
    const issues: RpcDecodeIssue[] = []
    for (const reader of readers) {
      const result = reader(raw)
      if (result.compatible) {
        return result
      }
      for (const issue of result.issues) {
        issues.push({ path: joinPath(reader.variant, issue.path), message: issue.message })
      }
    }
    return { compatible: false, issues: boundIssues(issues) }
  }
}

function decodeIssues(error: z.ZodError): RpcDecodeIssue[] {
  return boundIssues(
    error.issues.map((issue) => ({
      path: issue.path.map((segment) => String(segment)).join('.'),
      message: issue.message
    }))
  )
}

// Why: a hostile or very foreign reply can issue per element; report a bounded sample and
// say how many were dropped rather than letting the diagnostic grow with the payload.
function boundIssues(issues: readonly RpcDecodeIssue[]): RpcDecodeIssue[] {
  if (issues.length <= MAX_REPORTED_DECODE_ISSUES) {
    return [...issues]
  }
  return [
    ...issues.slice(0, MAX_REPORTED_DECODE_ISSUES),
    { path: '', message: `${issues.length - MAX_REPORTED_DECODE_ISSUES} further issues omitted` }
  ]
}

function joinPath(variant: string, path: string): string {
  return path ? `${variant}.${path}` : variant
}

function describeThrow(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
