// The CLI version each model on Orca's list needs, read from Orca's repo at most hourly.

import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import { getMainHttpClient } from '../network/http-client'
import { compareAppVersions } from '../../shared/app-lifecycle/identity/app-version'
import type {
  AgentCliModelRequirement,
  AgentCliUpdateAgent
} from '../../shared/agent-launch/installation/agent-cli-update'
import bundled from './agent-cli-model-requirements.json'

// Every released app reads this path, so the file must stay where it is.
const LIST_URL =
  'https://raw.githubusercontent.com/stablyai/orca/main/src/main/agent-cli-update/agent-cli-model-requirements.json'
const REFRESH_MS = 60 * 60_000
const LIST_TIMEOUT_MS = 10_000

// Agents an older app doesn't know are kept here and skipped on lookup, so the file can grow.
const listSchema = lazyZodSchema(() =>
  z.object({
    models: z.array(
      z.object({
        agent: z.string(),
        id: z.string().min(1),
        name: z.string().min(1),
        minVersion: z.string().regex(/^\d+\.\d+\.\d+$/)
      })
    )
  })
)
export type AgentCliModelRequirementList = z.infer<typeof listSchema>

const BUNDLED_LIST = listSchema.parse(bundled)

let fetched: { list: AgentCliModelRequirementList | null; at: number } | null = null
let lookup: Promise<void> | null = null

async function fetchList(): Promise<AgentCliModelRequirementList> {
  const response = await getMainHttpClient().fetch(LIST_URL, {
    signal: AbortSignal.timeout(LIST_TIMEOUT_MS)
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`model list lookup failed (${response.status})`)
  }
  return listSchema.parse(await response.json())
}

/** The published list, else the one this build shipped with. */
async function currentList(): Promise<AgentCliModelRequirementList> {
  if (!fetched || Date.now() - fetched.at >= REFRESH_MS) {
    lookup ??= fetchList()
      .then((list) => {
        fetched = { list, at: Date.now() }
      })
      .catch((error: unknown) => {
        // Waits out the hour on the last good list, so an offline host isn't asked on every check.
        fetched = { list: fetched?.list ?? null, at: Date.now() }
        console.warn('[agent-cli-update] model list lookup failed:', error)
      })
      .finally(() => {
        lookup = null
      })
    await lookup
  }
  return fetched?.list ?? BUNDLED_LIST
}

/** Models `installed` is too old for that `latest` brings, in list order (newest first). */
export function modelsNeedingCliUpdate(
  list: AgentCliModelRequirementList,
  agent: AgentCliUpdateAgent,
  installed: string,
  latest: string
): AgentCliModelRequirement[] {
  return list.models
    .filter(
      (model) =>
        model.agent === agent &&
        compareAppVersions(installed, model.minVersion) < 0 &&
        compareAppVersions(latest, model.minVersion) >= 0
    )
    .map(({ id, name, minVersion }) => ({ id, name, minVersion }))
}

export async function readModelsNeedingCliUpdate(
  agent: AgentCliUpdateAgent,
  installed: string,
  latest: string
): Promise<AgentCliModelRequirement[]> {
  return modelsNeedingCliUpdate(await currentList(), agent, installed, latest)
}
