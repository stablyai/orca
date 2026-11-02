import { expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  seam,
  resetService,
  service,
  current,
  file,
  read,
  write,
  install,
  remove,
  erase,
  storage,
  documentPath,
  document,
  slot,
  pausedEdit
} from './claude-system-statusline.test-fixture'

const userValues = {
  model: 'opus',
  permissions: { allow: ['Read'] },
  statusLine: { type: 'command', command: '/user/owned-statusline' }
}

async function editCurrent(name: string, missing = false) {
  const prior = missing ? {} : await read(file(name))
  const edited = {
    ...prior,
    ...userValues,
    hooks: {
      ...prior.hooks,
      Notification: [{ hooks: [{ type: 'command', command: '/user/notifier' }] }]
    }
  }
  await write(file(name), edited)
}

function checkUserValues(actual: Record<string, unknown>) {
  expect(actual).toMatchObject(userValues)
  expect(actual.hooks).toMatchObject({
    Notification: [{ hooks: [{ type: 'command', command: '/user/notifier' }] }]
  })
}

it('control: fresh reread preserves a user edit during the initial optional metadata lookup', async () => {
  await install('seed')
  await write(file('X'), { model: 'sonnet' })
  const meta = await documentPath()
  const result = await pausedEdit(
    (method, path) => method === 'readFile' && path === meta,
    () => install('X'),
    () => editCurrent('X')
  )
  const actual = await read(file('X'))
  expect(result.state).toBe('installed')
  expect(actual.hooks.SessionStart).toHaveLength(1)
  checkUserValues(actual)
  expect((await install('X')).state).toBe('installed')
  checkUserValues(await read(file('X')))
})

it('preserves a user edit while the own-retirement journal is being saved', async () => {
  await install('X')
  const before = await read(file('X'))
  await write(file('X'), { ...before, model: 'sonnet' })
  const meta = await documentPath()
  const result = await pausedEdit(
    (method, path) => method === 'rename' && path === meta,
    () => install('X', { claudeVersion: '1.0.0' }),
    () => editCurrent('X')
  )
  const actual = await read(file('X'))
  expect(result.state).toBe('installed')
  expect((await install('X')).state).toBe('installed')
  checkUserValues(actual)
  checkUserValues(await read(file('X')))
})

it('preserves a user-created config while a missing-file publication waits for optional metadata', async () => {
  await install('seed')
  const meta = await documentPath()
  const result = await pausedEdit(
    (method, path) => method === 'readFile' && path === meta,
    () => install('X'),
    () => editCurrent('X', true)
  )
  const actual = await read(file('X'))
  expect(result.state).toBe('installed')
  expect(actual.hooks.SessionStart).toHaveLength(1)
  checkUserValues(actual)
  expect((await install('X')).state).toBe('installed')
  checkUserValues(await read(file('X')))
})

it('preserves a completed user save during reset identity preparation', async () => {
  await install('X')
  const meta = await documentPath()
  let reset = false
  seam.after = async (method, path) => {
    if (method === 'rename' && path === meta) {
      reset = true
    }
  }
  const result = await pausedEdit(
    (method, path) => reset && method === 'stat' && path === dirname(file('X')),
    () => remove('X'),
    () => editCurrent('X')
  )
  expect(result.state).toBe('not_installed')
  checkUserValues(await read(file('X')))
  expect(
    (await document()).destinations.some((entry: { path: string }) => entry.path === file('X'))
  ).toBe(false)
  expect((await install('X')).state).toBe('installed')
  checkUserValues(await read(file('X')))
})

it('honors a deletion completed during its own retirement journal, then retries without replay', async () => {
  await install('X')
  const meta = await documentPath()
  const result = await pausedEdit(
    (method, path) => method === 'rename' && path === meta,
    () => install('X', { claudeVersion: '1.0.0' }),
    () => erase('X')
  )
  expect(result.state).toBe('installed')
  expect((await document()).destinations[0].phase).toBe('managed')
  expect((await install('X')).state).toBe('installed')
  expect((await read(file('X'))).statusLine).toBeUndefined()
})

it.each(['empty', 'invalid'] as const)(
  'reclassifies fresh %s settings after missing-file evidence',
  async (kind) => {
    await install('seed')
    const meta = await documentPath()
    const bytes = kind === 'empty' ? '{"model":"opus"}' : '["not a settings object"]'
    const result = await pausedEdit(
      (method, path) => method === 'readFile' && path === meta,
      () => install('X'),
      async () => {
        await fs.mkdir(dirname(file('X')), { recursive: true })
        await fs.writeFile(file('X'), bytes)
      }
    )
    if (kind === 'invalid') {
      expect(result.state).toBe('error')
      expect(await fs.readFile(file('X'), 'utf8')).toBe(bytes)
      await write(file('X'), { model: 'opus' })
      expect((await install('X')).state).toBe('installed')
    } else {
      expect(result.state).toBe('installed')
    }
    expect(await read(file('X'))).toMatchObject({ model: 'opus' })
    expect((await read(file('X'))).statusLine).toBeDefined()
  }
)

async function selectedParentEdit(
  nth: number,
  operation: () => ReturnType<typeof install>,
  retarget: boolean
) {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  let count = 0
  let held = false
  let expired = false
  const emergency = setTimeout(() => {
    expired = true
    released.resolve()
    entered.resolve()
  }, 3000)
  seam.after = async (method, path) => {
    if (method === 'stat' && path === dirname(file('A')) && ++count === nth) {
      held = true
      entered.resolve()
      await released.promise
    }
  }
  const pending = operation()
  try {
    await entered.promise
    expect(held).toBe(true)
    expect(expired).toBe(false)
    if (retarget) {
      await fs.unlink(dirname(file('alias')))
      await fs.symlink(dirname(file('B')), dirname(file('alias')), 'junction')
    }
    released.resolve()
    const result = await pending
    expect(expired).toBe(false)
    return result
  } finally {
    released.resolve()
    await pending
    clearTimeout(emergency)
    seam.after = null
    expect(await fs.readdir(join(storage(), 'lock'))).toEqual([])
    for (const name of ['A', 'B']) {
      expect(
        (await fs.readdir(dirname(file(name)))).filter((entry) => entry.endsWith('.tmp'))
      ).toEqual([])
    }
  }
}

it.each(['control', 'install', 'retire', 'off'] as const)(
  'retains selected physical A through directory retarget: %s',
  async (mode) => {
    await write(file('A'), { model: 'sonnet' })
    expect((await install('A')).state).toBe('installed')
    const deleted = mode === 'control' || mode === 'install'
    if (deleted) {
      await erase('A')
    }
    await write(file('B'), {
      model: 'opus',
      permissions: { allow: ['Read'] },
      hooks: { Notification: [{ hooks: [{ type: 'command', command: '/user/notify' }] }] }
    })
    if (!deleted) {
      expect((await install('B')).state).toBe('installed')
    }
    await fs.symlink(dirname(file('A')), dirname(file('alias')), 'junction')
    const bBytes = await fs.readFile(file('B'), 'utf8')
    const bBackup = await fs.readFile(`${file('B')}.bak`, 'utf8').catch(() => null)
    const bRecord = (await document()).destinations.find(
      (entry: { path: string }) => entry.path === file('B')
    )
    const result = await selectedParentEdit(
      deleted ? 1 : 2,
      () =>
        mode === 'off'
          ? remove('alias')
          : install('alias', mode === 'retire' ? { claudeVersion: '1.0.0' } : current),
      mode !== 'control'
    )
    expect(result.state).toBe(deleted && mode !== 'control' ? 'not_installed' : 'installed')
    expect(result.managedHooksPresent).toBe(mode === 'control' || mode === 'off')
    expect(slot(await read(file('A')))).toBe('empty')
    expect(await fs.readFile(file('B'), 'utf8')).toBe(bBytes)
    expect(await fs.readFile(`${file('B')}.bak`, 'utf8').catch(() => null)).toBe(bBackup)
    const owners = (await document()).destinations
    expect(owners.find((entry: { path: string }) => entry.path === file('B'))).toEqual(bRecord)
    expect(owners.some((entry: { path: string }) => entry.path === file('A'))).toBe(deleted)
    if (mode !== 'control') {
      expect((await install('B')).state).toBe('installed')
      expect(slot(await read(file('B')))).toBe('managed')
      expect(await read(file('B'))).toMatchObject({
        model: 'opus',
        permissions: { allow: ['Read'] },
        hooks: { Notification: [{ hooks: [{ command: '/user/notify' }] }] }
      })
    }
  }
)

async function simulatedNativeScope(run: () => Promise<void>, capability = 'getter') {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    await resetService()
    const native = await import('../windows/windows-process-table')
    native.__setWindowsProcessTreeLoaderForTests(() =>
      capability === 'missing'
        ? null
        : {
            ProcessDataFlag: { None: 0, CommandLine: 2 },
            getAllProcesses: () => {
              throw new Error('No native table read permitted')
            },
            ...(capability === 'older'
              ? {}
              : { getProcessCreationTime: (pid: number) => seam.nativeBirth?.(pid) ?? undefined })
          }
    )
    await run()
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
}

it('installs cold with native or unavailable getters, freezes fallback and preserves reset/no-op through the full service', async () => {
  for (const capability of ['getter', 'missing', 'older', 'null']) {
    seam.nativeBirth = () => (capability === 'getter' ? 1777777777000 : null)
    seam.cim = async () => {
      throw new Error('No self or cleanup CIM permitted')
    }
    await simulatedNativeScope(async () => {
      seam.probes = 0
      const name = capability
      const first = await install(name)
      expect(first.state, JSON.stringify(first)).toBe('installed')
      expect(first.managedHooksPresent).toBe(true)
      expect(slot(await read(file(name)))).toBe('managed')
      expect((await read(file(name))).hooks.SessionStart).toHaveLength(1)
      expect(
        (await document()).destinations.some((entry: { path: string }) => entry.path === file(name))
      ).toBe(true)
      const bytes = await fs.readFile(file(name), 'utf8')
      const receipt = await fs.readFile(await documentPath(), 'utf8')
      // Capability returning cannot change the frozen lifecycle of a live process.
      seam.nativeBirth = () => 1777777777000
      expect((await install(name)).state).toBe('installed')
      expect(await fs.readFile(file(name), 'utf8')).toBe(bytes)
      expect(await fs.readFile(await documentPath(), 'utf8')).toBe(receipt)
      expect((await remove(name)).state).toBe('not_installed')
      expect(slot(await read(file(name)))).toBe('empty')
      expect((await install(name)).state).toBe('installed')
      expect(await fs.readdir(join(storage(), 'lock'))).toEqual([])
      expect(seam.probes).toBe(1) // Existing host registry only; no self/cleanup CIM.
    }, capability)
  }
})

it('protects incompatible owners and claims, recovers exact abandoned lifecycle and bounds actual conflicting CIM through release', async () => {
  seam.nativeBirth = () => null
  await simulatedNativeScope(async () => {
    const { withManagedHookInstallLock } = await import('../agent-hooks/managed-hook-install-lock')
    const { readStatusLineEvidence } = await import('./statusline-ownership')
    const parent = join(storage(), 'lock')
    const lock = join(parent, 'managed-hook-install.lock')
    const token = '00000000-0000-4000-8000-000000000000'
    const claimToken = '11111111-1111-4111-8111-111111111111'
    const ownerPath = join(parent, `managed-hook-install.owner-${token}.json`)
    const claimed = join(parent, `managed-hook-install.claimed-${token}-${claimToken}.json`)
    const claim = join(parent, `managed-hook-install.claim-${token}-${claimToken}.json`)
    const seed = async (identity: string, host = 'win32:fixture-host') => {
      await fs.mkdir(parent, { recursive: true })
      const owner = { token, pid: process.pid, hostIdentity: host, processIdentity: identity }
      await fs.writeFile(ownerPath, JSON.stringify(owner))
      await fs.link(ownerPath, lock)
      return owner
    }
    const clean = async () => {
      for (const path of [lock, ownerPath, claimed, claim]) {
        await fs.unlink(path).catch(() => {})
      }
    }
    seam.cim = async () => ({ stdout: '1777777777000', stderr: '' })
    for (const identity of [
      'runtime:other-context',
      `win32:${process.pid}:bad`,
      `win32:${process.pid + 1}:1`
    ]) {
      await seed(identity)
      const bytes = await fs.readFile(lock, 'utf8')
      expect((await install('protected')).state).toBe('error')
      expect(await fs.readFile(lock, 'utf8')).toBe(bytes)
      await clean()
    }
    await seed('runtime:other-context')
    await fs.unlink(lock)
    await fs.writeFile(
      claim,
      JSON.stringify({
        ownerToken: token,
        claimToken,
        pid: process.pid,
        hostIdentity: 'win32:fixture-host',
        processIdentity: 'runtime:other-context'
      })
    )
    const cleanupProbes = seam.probes
    expect((await install('unknown-residue')).state).toBe('installed')
    expect(seam.probes).toBe(cleanupProbes)
    expect((await fs.readdir(parent)).sort()).toEqual(
      [ownerPath, claim].map((path) => path.slice(parent.length + 1)).sort()
    )
    await clean()
    await seed(`win32:${process.pid}:1777777777000`)
    const beforeSame = seam.probes
    expect((await install('same')).state).toBe('error')
    expect(seam.probes - beforeSame).toBe(1) // One observation for the unchanged token, not each poll.
    await clean()
    await seed(`win32:${process.pid}:1`, 'foreign')
    expect((await install('foreign')).state).toBe('error')
    await clean()
    await seed(`win32:${process.pid}:1`)
    expect((await install('reused')).state).toBe('installed')
    expect(await fs.readdir(parent)).toEqual([])
    await seed(`win32:${process.pid}:1`)
    await fs.rename(ownerPath, claimed)
    await fs.writeFile(
      claim,
      JSON.stringify({
        ownerToken: token,
        claimToken,
        pid: process.pid,
        hostIdentity: 'win32:fixture-host',
        processIdentity: 'runtime:other-context'
      })
    )
    const priorClaim = await fs.readFile(claim, 'utf8')
    expect((await install('opaque-claim')).state).toBe('error')
    expect(await fs.readFile(claim, 'utf8')).toBe(priorClaim)
    await clean()
    // A failed real release leaves an inactive exact-local owner; next invocation derives recovery.
    let localIdentity = ''
    const options = { lockParent: parent, waitTimeoutMs: 250, readEvidence: readStatusLineEvidence }
    await withManagedHookInstallLock(
      seam.home,
      undefined,
      async () => {
        localIdentity = JSON.parse(await fs.readFile(lock, 'utf8')).processIdentity
        await fs.unlink(ownerPath).catch(() => {})
        const current = JSON.parse(await fs.readFile(lock, 'utf8'))
        await fs.rename(
          join(parent, `managed-hook-install.owner-${current.token}.json`),
          `${lock}.held`
        )
      },
      'win32:fixture-host',
      options
    )
    await fs.rename(`${lock}.held`, ownerPath)
    await fs.unlink(lock)
    await fs.writeFile(
      ownerPath,
      JSON.stringify({
        token,
        pid: process.pid,
        hostIdentity: 'win32:fixture-host',
        processIdentity: localIdentity
      })
    )
    await fs.link(ownerPath, lock)
    await fs.rename(ownerPath, claimed)
    await fs.writeFile(
      claim,
      JSON.stringify({
        ownerToken: token,
        claimToken,
        pid: process.pid,
        hostIdentity: 'win32:fixture-host',
        processIdentity: localIdentity
      })
    )
    expect((await install('inactive')).state).toBe('installed')
    expect(await fs.readdir(parent)).toEqual([])

    const changingOwner = await seed(`win32:${process.pid}:1`)
    await fs.rename(ownerPath, claimed)
    let ownerToken = token
    let recoveryToken = claimToken
    const changedToken = '22222222-2222-4222-8222-222222222222'
    const changedOwner = '33333333-3333-4333-8333-333333333333'
    const claimPath = () =>
      join(parent, `managed-hook-install.claim-${ownerToken}-${recoveryToken}.json`)
    const witnessPath = () =>
      join(parent, `managed-hook-install.claimed-${ownerToken}-${recoveryToken}.json`)
    const putClaim = () =>
      fs.writeFile(
        claimPath(),
        JSON.stringify({
          ownerToken,
          claimToken: recoveryToken,
          pid: process.pid,
          hostIdentity: 'win32:fixture-host',
          processIdentity: `win32:${process.pid}:1777777777000`
        })
      )
    await putClaim()
    let reads = 0
    let observations = 0
    const samples: number[] = []
    const invalidationCancel = new AbortController()
    seam.cim = async () => {
      observations++
      return { stdout: '1777777777000', stderr: '' }
    }
    seam.after = async (method, path) => {
      if (method !== 'readFile' || path !== claimPath() || observations === 0) {
        return
      }
      if (++reads % 2 !== 0) {
        return
      }
      samples.push(observations)
      const priorClaimPath = claimPath(),
        priorWitness = witnessPath()
      if (reads === 2) {
        recoveryToken = changedToken
        await putClaim()
        await fs.rename(priorWitness, witnessPath())
        await fs.unlink(priorClaimPath)
      } else if (reads === 4) {
        ownerToken = changedOwner
        await putClaim()
        await fs.writeFile(witnessPath(), JSON.stringify({ ...changingOwner, token: ownerToken }))
        await fs.unlink(lock)
        await fs.link(witnessPath(), lock)
        await fs.unlink(priorClaimPath)
        await fs.unlink(priorWitness)
      } else {
        invalidationCancel.abort()
      }
    }
    try {
      const status = await service().installSystem({
        ...current,
        target: { kind: 'system-default', configDir: dirname(file('invalidation')) },
        signal: invalidationCancel.signal
      })
      expect(status.state).toBe('error')
      expect(samples).toEqual([2, 3, 5])
      expect(reads).toBe(6)
      await expect(fs.readFile(file('invalidation'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(JSON.parse(await fs.readFile(lock, 'utf8')).token).toBe(changedOwner)
      console.log('SL_ROLE_INVALIDATION', JSON.stringify({ reads, samples, observations, status }))
    } finally {
      seam.after = null
      invalidationCancel.abort()
    }
    for (const path of [lock, claimPath(), witnessPath()]) {
      await fs.unlink(path)
    }

    await seed(`win32:${process.pid}:1`)
    const sourceBytes = await fs.readFile(lock, 'utf8')
    const sourceCancel = new AbortController()
    let sourceSettled = false
    seam.calls = new Map()
    const canceledSource = await pausedEdit(
      (method, path) => method === 'readFile' && path === ownerPath,
      () =>
        service()
          .installSystem({
            ...current,
            target: { kind: 'system-default', configDir: dirname(file('canceled-source')) },
            signal: sourceCancel.signal
          })
          .finally(() => {
            sourceSettled = true
          }),
      async () => {
        sourceCancel.abort()
        await new Promise((resolve) => setImmediate(resolve))
        expect(sourceSettled).toBe(false)
      }
    )
    expect(canceledSource.state).toBe('error')
    expect(sourceSettled).toBe(true)
    expect(
      [...seam.calls].filter(([key]) =>
        key.startsWith(`writeFile:${parent}/managed-hook-install.claim-`)
      )
    ).toEqual([])
    expect(await fs.readFile(lock, 'utf8')).toBe(sourceBytes)
    await expect(fs.readFile(file('canceled-source'))).rejects.toMatchObject({ code: 'ENOENT' })
    console.log(
      'SL_CANCELED_SOURCE_JOIN',
      JSON.stringify({ canceledSource, sourceSettled, claimWrites: 0 })
    )
    seam.calls = null
    await clean()

    const raw = Promise.withResolvers<{ stdout: string; stderr: string }>()
    let admitted = 0
    const rawEntered = Promise.withResolvers<void>()
    seam.cim = () => {
      admitted++
      rawEntered.resolve()
      return raw.promise
    }
    await seed(`win32:${process.pid}:1`)
    const bytes = await fs.readFile(lock, 'utf8')
    const started = performance.now()
    let rawWaitMs = 0
    try {
      const controller = new AbortController()
      const p = service().installSystem({
        ...current,
        target: { kind: 'system-default', configDir: dirname(file('blocked')) },
        signal: controller.signal
      })
      try {
        await rawEntered.promise
        controller.abort()
        expect((await p).state).toBe('error')
      } finally {
        controller.abort()
        await p
      }
      for (let index = 0; index < 2; index++) {
        expect((await install('blocked')).state).toBe('error')
      }
      expect(admitted).toBe(2)
      rawWaitMs = performance.now() - started
      expect(performance.now() - started).toBeLessThan(1500)
      expect(await fs.readFile(lock, 'utf8')).toBe(bytes)
      await expect(fs.readFile(file('blocked'))).rejects.toMatchObject({ code: 'ENOENT' })
      raw.resolve({ stdout: '1777777777000', stderr: '' })
      await raw.promise
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      raw.resolve({ stdout: '1777777777000', stderr: '' })
      await raw.promise
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(await fs.readFile(lock, 'utf8')).toBe(bytes)
    expect((await install('blocked')).state).toBe('installed')
    expect(await fs.readdir(parent)).toEqual([])

    const releaseRaw = Promise.withResolvers<{ stdout: string; stderr: string }>()
    seam.cim = () => releaseRaw.promise
    const releaseStart = performance.now()
    let releaseWaitMs = 0
    try {
      await withManagedHookInstallLock(
        seam.home,
        undefined,
        async () => {
          const current = JSON.parse(await fs.readFile(lock, 'utf8'))
          await fs.rename(
            join(parent, `managed-hook-install.owner-${current.token}.json`),
            join(parent, `managed-hook-install.claimed-${current.token}-${claimToken}.json`)
          )
          await fs.writeFile(
            join(parent, `managed-hook-install.claim-${current.token}-${claimToken}.json`),
            JSON.stringify({
              ownerToken: current.token,
              claimToken,
              pid: process.pid,
              hostIdentity: 'win32:fixture-host',
              processIdentity: `win32:${process.pid}:1`
            })
          )
        },
        'win32:fixture-host',
        options
      )
      releaseWaitMs = performance.now() - releaseStart
      expect(releaseWaitMs).toBeLessThan(1000)
      const residue = await fs.readFile(lock, 'utf8')
      releaseRaw.resolve({ stdout: '1777777777000', stderr: '' })
      await releaseRaw.promise
      await new Promise((resolve) => setImmediate(resolve))
      expect(await fs.readFile(lock, 'utf8')).toBe(residue)
      expect((await install('release-recovery')).state).toBe('installed')
      expect(await fs.readdir(parent)).toEqual([])
    } finally {
      releaseRaw.resolve({ stdout: '1777777777000', stderr: '' })
      await releaseRaw.promise
      await new Promise((resolve) => setImmediate(resolve))
    }
    console.log(
      'SL_CONFLICT_BOUND',
      JSON.stringify({ admitted, rawWaitMs, releaseWaitMs, elapsed: performance.now() - started })
    )
  })
})
