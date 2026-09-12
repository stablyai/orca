import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'

// Pipe the baseline ssh-target-cleanup.ts source on stdin; no app or network is used.
const entry = path.resolve('src/renderer/src/store/slices/ssh-target-cleanup.ts')
const sources = [readFileSync(0, 'utf8'), readFileSync(entry, 'utf8')]
assert(
  sources.every((source) => source.includes('export function buildRemovedSshTargetCleanupPatch'))
)

async function load(source, instrument = false) {
  if (instrument) {
    const spread = '...nextTabsByWorktree'
    assert.equal(source.split(spread).length, 2)
    source = source.replace(spread, '...countTabMapCopy(nextTabsByWorktree)')
    source += `
      export const tabMapCopies = { count: 0, entries: 0 };
      function countTabMapCopy(map) {
        tabMapCopies.count++;
        tabMapCopies.entries += Reflect.ownKeys(map).length;
        return map;
      }
    `
  }
  source += "\nexport { toAppSshPtyId } from '../../../../shared/ssh-pty-id';"
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: [
      {
        name: 'cleanup-source',
        setup(builder) {
          builder.onLoad({ filter: /ssh-target-cleanup\.ts$/ }, () => ({
            contents: source,
            loader: 'ts',
            resolveDir: path.dirname(entry)
          }))
        }
      }
    ]
  })
  const bundled = `${result.outputFiles[0].text}\n//# sourceURL=ssh-cleanup-benchmark-bundle.js`
  return import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`)
}

const modules = await Promise.all(sources.map((source) => load(source)))
const arms = modules.map((module) => module.buildRemovedSshTargetCleanupPatch)
const { toAppSshPtyId } = modules[0]

function emptyState() {
  return {
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    pendingCodexPaneRestartIds: {},
    codexRestartNoticeByPtyId: {},
    deferredSshSessionIdsByTabId: {},
    pendingReconnectPtyIdByTabId: {},
    directSshPaneRetryByTabId: {},
    directSshLivePtyBindingByTabId: {},
    directSshPaneRetryHistoryByTabId: {},
    deferredSshReconnectTargets: [],
    transientClearedAgentStatusConnectionIds: {},
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map(),
    sshTargetGenerations: new Map(),
    remoteWorkspaceHydratedTargetIds: new Set(),
    remoteWorkspaceSyncStatusByTargetId: {},
    portForwardsByConnection: {},
    detectedPortsByConnection: {},
    sshCredentialQueue: []
  }
}

function freezeState(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value
  }
  if (value instanceof Map || value instanceof Set) {
    for (const item of value.values()) {
      freezeState(item)
    }
  } else {
    for (const item of Object.values(value)) {
      freezeState(item)
    }
  }
  return Object.freeze(value)
}

function tab(id, worktreeId, ptyId) {
  return {
    id,
    worktreeId,
    ptyId,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    pendingActivationSpawn: true
  }
}

function timedState(count, stride, catalog, tabsPerWorkspace = 1) {
  const state = emptyState()
  if (catalog) {
    state.repos.push({ id: 'repo', path: '/remote', connectionId: 'removed' })
  }
  state.worktreesByRepo.repo = []
  for (let i = 0; i < count; i++) {
    const selected = stride > 0 && i % stride === 0
    const worktreeId = catalog ? `repo::/remote/${i}` : `folder:${i}`
    const ptyId = toAppSshPtyId(selected ? 'removed' : 'other', `pty-${i}`)
    state.tabsByWorktree[worktreeId] = Array.from({ length: tabsPerWorkspace }, (_, j) =>
      tab(`tab-${i}-${j}`, worktreeId, ptyId)
    )
    if (catalog) {
      state.worktreesByRepo.repo.push({ id: worktreeId, repoId: 'repo', path: `/remote/${i}` })
    }
  }
  return freezeState(state)
}

function compare(state, targetId) {
  const before = structuredClone(state)
  const results = arms.map((arm) => arm(state, targetId))
  assert.deepEqual(results[1], results[0])
  assert.deepEqual(state, before)
  for (const key of Object.keys(results[0] ?? {})) {
    assert.equal(results[1][key] === state[key], results[0][key] === state[key])
  }
  for (const [key, tabs] of Object.entries(state.tabsByWorktree)) {
    const next = results.map((result) => result?.tabsByWorktree?.[key] ?? tabs)
    assert.equal(next[1] === tabs, next[0] === tabs)
    for (let i = 0; i < tabs.length; i++) {
      assert.equal(next[1][i] === tabs[i], next[0][i] === tabs[i])
    }
  }
  return results
}

let seed = 0x15c0ffee
function random(max) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return (seed >>> 8) % max
}

for (let iteration = 0; iteration < 3000; iteration++) {
  const state = emptyState()
  const targets = ['removed', 'other', 'space / @ Unicode 🐳']
  for (const targetId of targets) {
    state.repos.push({ id: 'collision', path: `/remote/${targetId}`, connectionId: targetId })
    if (random(2)) {
      state.sshConnectionStates.set(targetId, { targetId, status: 'disconnected' })
    }
    if (random(2)) {
      state.sshTargetLabels.set(targetId, targetId)
    }
    if (random(2)) {
      state.sshTargetGenerations.set(targetId, random(10))
    }
    if (random(2)) {
      state.remoteWorkspaceHydratedTargetIds.add(targetId)
    }
    if (random(2)) {
      state.deferredSshReconnectTargets.push(targetId)
    }
    if (random(2)) {
      state.transientClearedAgentStatusConnectionIds[targetId] = true
    }
    if (random(2)) {
      state.remoteWorkspaceSyncStatusByTargetId[targetId] = { phase: 'synced' }
    }
    if (random(2)) {
      state.portForwardsByConnection[targetId] = [{ localPort: 8000 }]
    }
    if (random(2)) {
      state.detectedPortsByConnection[targetId] = [{ port: 8001 }]
    }
    if (random(2)) {
      state.sshCredentialQueue.push({ targetId, requestId: targetId, kind: 'password' })
    }
  }
  const count = random(24)
  for (let i = 0; i < count; i++) {
    const key = ['__proto__', 'constructor', 'toString'][i] ?? `folder:${i}`
    const owner = targets[random(targets.length)]
    const rows = Array.from({ length: random(5) }, (_, j) => {
      const id = `tab-${i}-${j}`
      const ptyId = [null, '', 'local-pty', 'ssh:bad', toAppSshPtyId(owner, `pty-${j}`)][random(5)]
      if (random(3) === 0) {
        state.ptyIdsByTabId[id] = [toAppSshPtyId(owner, 'split'), 'local-split']
      }
      if (random(3) === 0) {
        state.lastKnownRelayPtyIdByTabId[id] = toAppSshPtyId(owner, 'last')
      }
      if (random(2)) {
        state.deferredSshSessionIdsByTabId[id] = ptyId ?? 'local'
      }
      if (random(2)) {
        state.pendingReconnectPtyIdByTabId[id] = toAppSshPtyId(owner, 'reconnect')
      }
      if (ptyId) {
        state.pendingCodexPaneRestartIds[ptyId] = true
        state.codexRestartNoticeByPtyId[ptyId] = {
          previousAccountLabel: 'old',
          nextAccountLabel: 'new'
        }
      }
      const authority = {
        targetId: targets[random(3)],
        providerEpoch: 'epoch',
        connectionGeneration: 1
      }
      if (random(2)) {
        state.directSshPaneRetryByTabId[id] = { authority, attemptId: id, tabGeneration: 1 }
      }
      if (random(2)) {
        state.directSshLivePtyBindingByTabId[id] = { authority, ptyId, tabGeneration: 1 }
      }
      if (random(2)) {
        state.directSshPaneRetryHistoryByTabId[id] = { authority, attemptedAt: [10] }
      }
      return tab(id, key, ptyId)
    })
    Object.defineProperty(state.tabsByWorktree, key, { value: rows, enumerable: true })
    if (i >= 3 && random(2)) {
      const worktree = {
        id: key,
        repoId: 'collision',
        path: `/remote/${i}`,
        hostId: `ssh:${encodeURIComponent(owner)}`
      }
      ;(state.worktreesByRepo.collision ??= []).push(worktree)
      if (random(2)) {
        state.detectedWorktreesByRepo.collision = { worktrees: [worktree] }
      }
    }
  }
  compare(freezeState(state), targets[random(3)])
}
console.log('3,000 frozen-state full-patch / identity differential cases passed')

// Instrument only the copy site for counts; timing arms above remain uninstrumented.
const counted = await Promise.all(sources.map((source) => load(source, true)))
for (const stride of [1, 10, 0]) {
  const state = timedState(100, stride, false)
  const expectedCopies = stride === 0 ? [0, 0] : [100 / stride, 1]
  counted.forEach((module, index) => {
    module.tabMapCopies.count = 0
    module.tabMapCopies.entries = 0
    assert.deepEqual(
      module.buildRemovedSshTargetCleanupPatch(state, 'removed'),
      arms[index](state, 'removed')
    )
    assert.deepEqual(module.tabMapCopies, {
      count: expectedCopies[index],
      entries: expectedCopies[index] * 100
    })
  })
  console.log(
    JSON.stringify({ stride, copiedEntries: counted.map((module) => module.tabMapCopies.entries) })
  )
}

function sample(arm, state, repeats) {
  const start = performance.now()
  let changed = 0
  for (let i = 0; i < repeats; i++) {
    changed += arm(state, 'removed') !== null ? 1 : 0
  }
  assert(changed === 0 || changed === repeats)
  return (performance.now() - start) / repeats
}

console.log(
  JSON.stringify({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    unit: 'ms',
    pairs: 8
  })
)
for (const [count, stride, catalog, tabsPerWorkspace] of [
  [1, 1, false, 1],
  [10, 1, false, 1],
  [100, 1, false, 1],
  [500, 1, false, 1],
  [1000, 1, false, 1],
  [100, 10, false, 1],
  [1000, 10, false, 1],
  [1000, 0, false, 1],
  [100, 1, true, 4],
  [500, 1, true, 4]
]) {
  const state = timedState(count, stride, catalog, tabsPerWorkspace)
  compare(state, 'removed')
  for (const arm of arms) {
    const until = performance.now() + 80
    while (performance.now() < until) {
      sample(arm, state, 1)
    }
  }
  const repeats = Math.max(1, Math.min(20000, Math.ceil(40 / sample(arms[0], state, 1))))
  /** @type {number[][]} */
  const samples = [[], []]
  for (let pair = 0; pair < 8; pair++) {
    for (const index of pair % 2 ? [1, 0] : [0, 1]) {
      samples[index].push(sample(arms[index], state, repeats))
    }
  }
  const median = samples.map((values) => {
    values.sort((a, b) => a - b)
    return (values[3] + values[4]) / 2
  })
  console.log(
    JSON.stringify({ count, stride, catalog, tabsPerWorkspace, repeats, median, samples })
  )
}
