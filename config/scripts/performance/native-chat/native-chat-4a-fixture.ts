// Seed the retained-history profile once through the seed arm's own host, so every arm starts from the same logical data.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import {
  launchArm,
  prepareWorkspace,
  stopArm,
  type Arm,
  type Workspace
} from './native-chat-4a-arm'
import { rpc, storageBytes } from './native-chat-4a-probes'
import { captureDiffTarget, writeSeedDiffs, type DiffChat } from './native-chat-4a-seed-diffs'
import { createChat, history, send, waitForDurable, waitForIdle } from './native-chat-4a-session'
import { expectedItems, fillerTurn, historyTurns, type Workload } from './native-chat-4a-workloads'

export type Manifest = {
  seedArm: string
  seedSha: string
  workload: Workload['profile']
  /** Digest of the seeded history recipe; a cached seed from another recipe is refused, never reused. */
  recipe: string
  toolOutputBytes: number
  workspace: Workspace
  largeSessionId: string
  /** Null when the recipe seeds no medium chat (the large-source profile). */
  mediumSessionId: string | null
  fillerSessionIds: string[]
  /** The last filler, which also holds the known completed diff originals; conversion rows report it apart. */
  diffChat: DiffChat
  largeItems: number
  mediumItems: number
  storageBytes: number
  /** Logical file bytes including the isolated provider home; absent in older cached seeds. */
  profileBytes?: number
  seedMs: number
}

const SLEEP_FILLERS_EVERY = 20

/** Count the large chat's rows by paging back from the tail; refuses a fixture that seeded fewer rows than its recipe. */
async function countItems(
  page: Page,
  sessionId: string,
  expectedTools?: { count: number; bytes: number }
): Promise<number> {
  let count = 0
  let tools = 0
  let cursor: unknown
  for (;;) {
    const read = await history(page, sessionId, cursor ? 'before' : 'tail', 200, cursor)
    count += read.page.items.length
    if (expectedTools) {
      for (const { body } of read.page.items) {
        if (body?.kind !== 'tool-call') {
          continue
        }
        if (body.state !== 'completed' || body.output?.byteLength !== expectedTools.bytes) {
          throw new Error(`seed: ${sessionId} has an incomplete tool or wrong output size`)
        }
        tools += 1
      }
    }
    if (!read.page.hasOlder) {
      if (expectedTools && tools !== expectedTools.count) {
        throw new Error(
          `seed: ${sessionId} has ${tools} completed tools, expected ${expectedTools.count}`
        )
      }
      return count
    }
    cursor = read.page.window.nextCursor
  }
}

/** A manifest this harness wrote from `recipe`; only the recipe digest decides reuse. */
function isManifestFrom(value: unknown, recipe: string): value is Manifest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'recipe' in value &&
    value.recipe === recipe &&
    'diffChat' in value
  )
}

const recipeOf = (workload: Workload, toolOutputBytes: number): string =>
  createHash('sha256')
    .update(JSON.stringify({ history: workload.history, toolOutputBytes, diffs: workload.diffs }))
    .digest('hex')
    .slice(0, 16)

/** Send a recipe chat's turns; a queued turn goes while its predecessor still runs, leaving released queue history behind. */
async function seedRecipeChat(
  page: Page,
  arm: Arm,
  worktreeId: string,
  workload: Workload,
  chat: 'large' | 'medium',
  log: (line: string) => void
): Promise<{ sessionId: string; items: number }> {
  const created = await createChat(page, arm, worktreeId)
  const turns = chat === 'large' ? workload.history.largeTurns : workload.history.mediumTurns
  let turn = 0
  for (const next of historyTurns(workload, chat)) {
    if (turn > 0 && !next.queued) {
      await waitForDurable(page, created.sessionId, `4A-TAIL-${chat}-${turn - 1}`)
    }
    await send(page, arm, created.sessionId, next.prompt)
    turn += 1
    if (turn % 250 === 0) {
      log(`seed: ${chat} chat ${turn}/${turns} turns`)
    }
  }
  await waitForDurable(page, created.sessionId, `4A-TAIL-${chat}-${turn - 1}`, 600_000)
  await waitForIdle(page, created.sessionId, 600_000)
  const items = await countItems(
    page,
    created.sessionId,
    workload.history.fillerTools === undefined
      ? undefined
      : {
          count: turns * workload.history.tools,
          bytes: workload.history.toolOutputBytes
        }
  )
  // Hosts may group a call with its result; fewer than prompt+reply per turn means turns were lost.
  if (items < turns * 2) {
    throw new Error(`seed: ${chat} chat holds ${items} rows for ${turns} turns`)
  }
  if (items < expectedItems(turns, workload)) {
    log(
      `seed: ${chat} chat holds ${items} visible rows; recipe writes ${expectedItems(turns, workload)}`
    )
  }
  return { sessionId: created.sessionId, items }
}

export async function seedProfile(input: {
  arm: Arm
  workload: Workload
  runDir: string
  profileDir: string
  repoPath: string
  stubCommand: string
  toolOutputBytes: number
  log: (line: string) => void
}): Promise<Manifest> {
  const seedDir = path.join(input.runDir, `seed-${input.workload.profile}-${input.toolOutputBytes}`)
  const manifestPath = `${seedDir}.json`
  const recipe = recipeOf(input.workload, input.toolOutputBytes)
  if (existsSync(manifestPath) && existsSync(seedDir)) {
    const cached: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!isManifestFrom(cached, recipe)) {
      const recorded =
        typeof cached === 'object' && cached !== null && 'recipe' in cached ? cached.recipe : null
      throw new Error(
        `${manifestPath} was seeded from another recipe (${String(recorded ?? 'none recorded')}, now ${recipe}); move it and ${seedDir} aside or use a new --out`
      )
    }
    return cached
  }
  const started = Date.now()
  const launch = await launchArm(input.arm, input.profileDir, input.stubCommand)
  try {
    const { page } = launch
    const workspace = await prepareWorkspace(page, input.repoPath, input.stubCommand)
    const recipeWorkload = {
      ...input.workload,
      history: { ...input.workload.history, toolOutputBytes: input.toolOutputBytes }
    }
    const large = await seedRecipeChat(
      page,
      input.arm,
      workspace.worktreeIds[0],
      recipeWorkload,
      'large',
      input.log
    )
    const medium =
      input.workload.history.mediumTurns > 0
        ? await seedRecipeChat(
            page,
            input.arm,
            workspace.worktreeIds[0],
            recipeWorkload,
            'medium',
            input.log
          )
        : null
    const fillerSessionIds: string[] = []
    const workspaceId = workspace.worktreeIds[1]
    for (let chat = 0; chat < input.workload.history.fillerChats; chat += 1) {
      const filler = await createChat(page, input.arm, workspaceId)
      for (
        let fillerTurnIndex = 0;
        fillerTurnIndex < input.workload.history.fillerTurns;
        fillerTurnIndex += 1
      ) {
        await send(
          page,
          input.arm,
          filler.sessionId,
          fillerTurn(chat, fillerTurnIndex, input.workload)
        )
        await waitForDurable(page, filler.sessionId, `4A-TAIL-filler-${chat}-${fillerTurnIndex}`)
      }
      fillerSessionIds.push(filler.sessionId)
      if (input.workload.history.fillerTools !== undefined) {
        await waitForIdle(page, filler.sessionId, 600_000)
        await countItems(page, filler.sessionId, {
          count: input.workload.history.fillerTurns * input.workload.history.fillerTools,
          bytes: input.workload.history.fillerToolOutputBytes ?? 500
        })
      }
      // Bound live provider processes: retained chats stay, their stubs stop.
      if ((chat + 1) % SLEEP_FILLERS_EVERY === 0) {
        await rpc(page, 'agentSession.sleepWorkspace', { workspaceId })
        input.log(`seed: ${chat + 1}/${input.workload.history.fillerChats} filler chats`)
      }
    }
    const diffSessionId = fillerSessionIds.at(-1)
    if (!diffSessionId) {
      throw new Error('seed: the recipe has no filler chat to hold the completed diffs')
    }
    await waitForIdle(page, diffSessionId, 600_000)
    const diffTarget = await captureDiffTarget(page, diffSessionId)
    await stopArm(launch)
    const diffChat = await writeSeedDiffs({
      arm: input.arm,
      scratch: path.join(input.runDir, 'scratch'),
      profileDir: input.profileDir,
      target: diffTarget,
      workload: input.workload
    })
    input.log(`seed: ${diffChat.itemIds.length} completed diffs written to ${diffSessionId}`)
    const manifest: Manifest = {
      seedArm: input.arm.name,
      seedSha: input.arm.sha,
      workload: input.workload.profile,
      recipe,
      toolOutputBytes: input.toolOutputBytes,
      workspace,
      largeSessionId: large.sessionId,
      mediumSessionId: medium?.sessionId ?? null,
      fillerSessionIds,
      diffChat,
      largeItems: large.items,
      mediumItems: medium?.items ?? 0,
      storageBytes: storageBytes(input.profileDir).total,
      profileBytes: storageBytes(input.profileDir, true).total,
      seedMs: Date.now() - started
    }
    renameSync(input.profileDir, seedDir)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    return manifest
  } catch (error) {
    await stopArm(launch).catch(() => undefined)
    throw error
  }
}

export const seedDirFor = (runDir: string, manifest: Manifest): string =>
  path.join(runDir, `seed-${manifest.workload}-${manifest.toolOutputBytes}`)

/** The untouched filler the background sweep reaches last (it converts in ascending session_id order). */
export function unconvertedOpenTarget(manifest: Manifest): string | null {
  return manifest.fillerSessionIds.slice(3, -1).sort().at(-1) ?? null
}

/** Every chat the seed made, in the sweep's order. */
export const seededChats = (manifest: Manifest): string[] =>
  [manifest.largeSessionId, manifest.mediumSessionId ?? [], manifest.fillerSessionIds].flat().sort()
