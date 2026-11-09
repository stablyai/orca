// Seed the retained-history profile once through the seed arm's own host, so every arm starts from the same logical data.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  launchArm,
  prepareWorkspace,
  stopArm,
  type Arm,
  type Workspace
} from './native-chat-4a-arm'
import { rpc, storageBytes } from './native-chat-4a-probes'
import { createChat, history, send, waitForDurable, waitForIdle } from './native-chat-4a-session'
import {
  fillerTurn,
  largeHistoryTurns,
  expectedLargeItems,
  type Workload
} from './native-chat-4a-workloads'

export type Manifest = {
  seedArm: string
  seedSha: string
  workload: Workload['profile']
  toolOutputBytes: number
  workspace: Workspace
  largeSessionId: string
  fillerSessionIds: string[]
  largeItems: number
  storageBytes: number
  seedMs: number
}

const SLEEP_FILLERS_EVERY = 20

/** Count the large chat's rows by paging back from the tail; refuses a fixture that seeded fewer rows than its recipe. */
async function countItems(
  page: Awaited<ReturnType<typeof launchArm>>['page'],
  sessionId: string
): Promise<number> {
  let count = 0
  let cursor: unknown
  for (;;) {
    const read = await history(page, sessionId, cursor ? 'before' : 'tail', 200, cursor)
    count += read.page.items.length
    if (!read.page.hasOlder) {
      return count
    }
    cursor = read.page.window.nextCursor
  }
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
  if (existsSync(manifestPath) && existsSync(seedDir)) {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
  }
  const started = Date.now()
  const launch = await launchArm(input.arm, input.profileDir, input.stubCommand)
  try {
    const { page } = launch
    const workspace = await prepareWorkspace(page, input.repoPath, input.stubCommand)
    const large = await createChat(page, input.arm, workspace.worktreeIds[0])
    let turn = 0
    for (const next of largeHistoryTurns({
      ...input.workload,
      history: { ...input.workload.history, toolOutputBytes: input.toolOutputBytes }
    })) {
      // A queued turn is sent while its predecessor still runs, leaving released queue history behind.
      if (turn > 0 && !next.queued) {
        await waitForDurable(page, large.sessionId, `4A-TAIL-large-${turn - 1}`)
      }
      await send(page, input.arm, large.sessionId, next.prompt)
      turn += 1
      if (turn % 250 === 0) {
        input.log(`seed: large chat ${turn}/${input.workload.history.largeTurns} turns`)
      }
    }
    await waitForDurable(page, large.sessionId, `4A-TAIL-large-${turn - 1}`, 600_000)
    await waitForIdle(page, large.sessionId, 600_000)
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
      // Bound live provider processes: retained chats stay, their stubs stop.
      if ((chat + 1) % SLEEP_FILLERS_EVERY === 0) {
        await rpc(page, 'agentSession.sleepWorkspace', { workspaceId })
        input.log(`seed: ${chat + 1}/${input.workload.history.fillerChats} filler chats`)
      }
    }
    const largeItems = await countItems(page, large.sessionId)
    // Hosts may group a call with its result; fewer than prompt+reply per turn means turns were lost.
    if (largeItems < input.workload.history.largeTurns * 2) {
      throw new Error(
        `seed: large chat holds ${largeItems} rows for ${input.workload.history.largeTurns} turns`
      )
    }
    if (largeItems < expectedLargeItems(input.workload)) {
      input.log(
        `seed: large chat holds ${largeItems} visible rows; recipe writes ${expectedLargeItems(input.workload)}`
      )
    }
    const manifest: Manifest = {
      seedArm: input.arm.name,
      seedSha: input.arm.sha,
      workload: input.workload.profile,
      toolOutputBytes: input.toolOutputBytes,
      workspace,
      largeSessionId: large.sessionId,
      fillerSessionIds,
      largeItems,
      storageBytes: 0,
      seedMs: 0
    }
    await stopArm(launch)
    manifest.storageBytes = storageBytes(input.profileDir).total
    manifest.seedMs = Date.now() - started
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
