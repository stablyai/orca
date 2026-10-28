import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  buildDnrRulesetInSlices,
  type DnrInvalidRulePolicy
} from './declarative-net-request/ruleset-builder'
import type { DnrRulesetIndex } from './declarative-net-request/ruleset-index'
import type { DnrRulesetSource } from './declarative-net-request/rule-types'

/** One manifest declarative_net_request.rule_resources entry. */
export type DnrManifestRuleset = {
  id: string
  path: string
  /** Enabled by the manifest; the extension can change it with updateEnabledRulesets. */
  enabled: boolean
  source: Extract<DnrRulesetSource, { kind: 'static' }>
}

export type DnrBuiltRuleset = {
  index: DnrRulesetIndex
  ruleCount: number
  regexRuleCount: number
  /** Has rules that act once response headers arrive (onHeadersReceived must run). */
  usesResponseStage: boolean
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

export function readDnrManifestRulesets(manifest: unknown): DnrManifestRuleset[] {
  const resources = record(record(manifest)?.declarative_net_request)?.rule_resources
  if (!Array.isArray(resources)) {
    return []
  }
  const rulesets: DnrManifestRuleset[] = []
  for (const entry of resources) {
    const fields = record(entry)
    const id = fields?.id
    const path = fields?.path
    if (typeof id !== 'string' || typeof path !== 'string' || id.startsWith('_')) {
      continue
    }
    rulesets.push({
      id,
      path,
      enabled: fields?.enabled === true,
      source: { kind: 'static', id, manifestIndex: rulesets.length }
    })
  }
  return rulesets
}

/** Response-header conditions, or response-header modifications applied at onHeadersReceived. */
export function dnrRulesUseResponseStage(rules: readonly unknown[]): boolean {
  return rules.some((rule) => {
    const condition = record(record(rule)?.condition)
    const action = record(record(rule)?.action)
    return (
      condition?.responseHeaders !== undefined ||
      condition?.excludedResponseHeaders !== undefined ||
      (action?.type === 'modifyHeaders' && action.responseHeaders !== undefined)
    )
  })
}

// Why time-boxed slices: one ruleset can take 100ms+ to index; requests and IPC run in between.
const BUILD_SLICE_SIZE = 50
const BUILD_TASK_BUDGET_MS = 8
let taskStartedAt = performance.now()

function yieldWhenOverBudget(): Promise<void> {
  if (performance.now() - taskStartedAt < BUILD_TASK_BUDGET_MS) {
    return Promise.resolve()
  }
  return new Promise((done) =>
    setImmediate(() => {
      taskStartedAt = performance.now()
      done()
    })
  )
}

export type DnrRulesBuild = { ok: true; built: DnrBuiltRuleset } | { ok: false; error: string }

/** Static rulesets skip invalid rules; API updates ('error') reject on the first one. */
export async function buildDnrRules(
  rules: readonly unknown[],
  extensionId: string,
  source: DnrRulesetSource,
  invalidRules: DnrInvalidRulePolicy
): Promise<DnrRulesBuild> {
  const result = await buildDnrRulesetInSlices(
    rules,
    { extensionId, source, invalidRules },
    BUILD_SLICE_SIZE,
    yieldWhenOverBudget
  )
  if (!result.ok) {
    return { ok: false, error: result.error.message }
  }
  return {
    ok: true,
    built: {
      index: result.index,
      ruleCount: result.ruleCount,
      regexRuleCount: result.regexRuleCount,
      usesResponseStage: dnrRulesUseResponseStage(rules)
    }
  }
}

async function loadStaticRuleset(
  extension: Pick<Electron.Extension, 'id' | 'path'>,
  ruleset: DnrManifestRuleset
): Promise<DnrBuiltRuleset | null> {
  const file = resolve(extension.path, ruleset.path.replace(/^\/+/, ''))
  const inside = relative(extension.path, file)
  if (inside.startsWith('..') || isAbsolute(inside)) {
    return null
  }
  const rules: unknown = JSON.parse(await readFile(file, 'utf8'))
  if (!Array.isArray(rules)) {
    return null
  }
  const result = await buildDnrRules(rules, extension.id, ruleset.source, 'warn')
  return result.ok ? result.built : null
}

type CacheEntry = { built: Promise<DnrBuiltRuleset | null>; users: number }

// Why shared: profiles that run the same extension version index each ruleset once.
const cache = new Map<string, CacheEntry>()

function cacheKey(
  extension: Pick<Electron.Extension, 'path' | 'version'>,
  rulesetId: string
): string {
  return `${extension.path}\n${extension.version}\n${rulesetId}`
}

/** Null when the ruleset file is missing or not a rule list (Chrome skips such rulesets). */
export function acquireDnrStaticRuleset(
  extension: Pick<Electron.Extension, 'id' | 'path' | 'version'>,
  ruleset: DnrManifestRuleset
): Promise<DnrBuiltRuleset | null> {
  const key = cacheKey(extension, ruleset.id)
  let entry = cache.get(key)
  if (!entry) {
    const built = loadStaticRuleset(extension, ruleset).catch((error: unknown) => {
      console.warn(`[browser-extensions] Could not load ruleset ${ruleset.id}:`, error)
      return null
    })
    entry = { built, users: 0 }
    cache.set(key, entry)
  }
  entry.users++
  return entry.built
}

export function releaseDnrStaticRuleset(
  extension: Pick<Electron.Extension, 'path' | 'version'>,
  rulesetId: string
): void {
  const key = cacheKey(extension, rulesetId)
  const entry = cache.get(key)
  if (entry && --entry.users <= 0) {
    cache.delete(key)
  }
}
