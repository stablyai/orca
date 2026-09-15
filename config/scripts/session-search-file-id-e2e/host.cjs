const { app } = require('electron')

const assert = require('node:assert/strict')

const fs = require('node:fs/promises')

const { existsSync, appendFileSync } = require('node:fs')

const { join } = require('node:path')

const { DatabaseSync } = require('node:sqlite')

const output = process.argv[2]

const phase = process.argv[3]

const profile = join(output, 'profile')

app.setPath('userData', profile)

app.setPath('sessionData', join(profile, 'chromium'))

app.disableHardwareAcceleration()

globalThis.__fileIdChildren = []

const report = {
  phase,
  pid: process.pid,
  execPath: process.execPath,
  versions: process.versions,
  stages: [],
  children: [],
  stderr: [],
  ipc: []
}

globalThis.__fileIdObserveChild = (child) => {
  globalThis.__fileIdChildren.push(child)
  child.stderr.on('data', (chunk) => report.stderr.push(String(chunk)))
  child.on('message', (message) =>
    report.ipc.push({ pid: child.pid, type: message.type, operation: message.operation })
  )
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const markers = {
  initial: 'quartzinitialmarker',
  append: 'cobaltappendedmarker',
  replacement: 'velvetreplacedmarker',
  disabled: 'tungstendisabledmarker'
}

let api

let registration

let transport

const endpoint = `\\\\.\\pipe\\orca-file-id-${process.pid}`

let settings = {}

let transcript

const database = join(profile, 'ai-vault', 'session-search.sqlite')

function record(stage, data = {}) {
  const entry = { stage, at: Date.now(), ...data }
  report.stages.push(entry)
  appendFileSync(join(output, `${phase}-stages.jsonl`), `${JSON.stringify(entry)}\n`)
  console.log(stage, JSON.stringify(data))
}

function inspect(marker) {
  const db = new DatabaseSync(database, { readOnly: true })

  try {
    const query = db.prepare(
      'SELECT CAST(ino AS TEXT) AS ino, byte_offset, size_bytes, mtime_ms FROM files WHERE path = ?'
    )

    const rows = db
      .prepare(`SELECT s.session_id FROM messages_fts f JOIN messages m ON m.id=f.rowid
      JOIN sessions s ON s.id=m.session_row_id WHERE messages_fts MATCH ?`)
      .all(marker)

    return { file: query.get(transcript), sessions: rows.map((row) => row.session_id) }
  } finally {
    db.close()
  }
}

async function query(marker, present) {
  const result = await api.runProcess({
    program: process.env.ORCA_FILE_ID_NODE,
    args: [
      join(output, 'client.cjs'),
      endpoint,
      JSON.stringify({ query: `"${marker}"`, scope: 'conversation', freshness: 'indexed' })
    ],
    env: process.env,
    timeoutMs: 15_000
  })

  assert.equal(result.code, 0, result.stderr)
  const external = JSON.parse(result.stdout)
  assert.equal(external.response.ok, true, JSON.stringify(external))
  const response = external.response.result
  assert.equal(response.kind, 'results', JSON.stringify(response))
  assert.equal(
    response.hits.some((hit) => hit.sessionId === sessionId),
    present,
    `RPC ${marker}`
  )
  const disk = inspect(marker)
  assert.equal(disk.sessions.includes(sessionId), present, `DB ${marker}`)
  const actual = await fs.stat(transcript)
  assert.equal(
    disk.file.byte_offset,
    actual.size,
    'Committed cursor covers actual transcript bytes'
  )
  assert.equal(disk.file.size_bytes, actual.size)
  assert.equal(disk.file.mtime_ms, actual.mtimeMs)
  record('query', { marker, present, clientPid: external.pid, endpoint, response, disk })
}

async function status() {
  return api.rpc('aiVault.searchStatus', {})
}

async function waitFor(predicate, label, timeout = 30_000) {
  const until = Date.now() + timeout

  while (Date.now() < until) {
    const current = await status()

    if (predicate(current)) {
      return current
    }

    await sleep(200)
  }

  throw new Error(`Timed out: ${label}`)
}

async function policy(next) {
  const before = settings
  settings = next
  await fs.writeFile(join(profile, 'fixture-settings.json'), JSON.stringify(settings))
  api.applySessionSearchSettingsChange(before, settings)
}

async function stopChild() {
  const children = [...globalThis.__fileIdChildren]
  api.resetAiVaultScannerServiceForTests()

  for (const child of children) {
    const until = Date.now() + 5000

    while (child.exitCode === null && child.signalCode === null && Date.now() < until) {
      await sleep(50)
    }

    assert.ok(
      child.exitCode !== null || child.signalCode !== null,
      `Child ${child.pid} did not exit`
    )

    if (!report.children.some((row) => row.pid === child.pid)) {
      report.children.push({
        pid: child.pid,
        spawnfile: child.spawnfile,
        spawnargs: child.spawnargs,
        exitCode: child.exitCode,
        signalCode: child.signalCode
      })
    }
  }
}

async function run() {
  assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
  await fs.mkdir(profile, { recursive: true })
  api = require('./production.js')
  api.setAppEnvironment({
    getPath: (name) => (name === 'userData' ? profile : app.getPath(name)),
    getAppPath: () => output,
    getVersion: () => app.getVersion(),
    isPackaged: () => false,
    onWillQuit: (handler) => app.on('will-quit', handler),
    exit: (code) => app.exit(code),
    getAppMetrics: () => app.getAppMetrics()
  })

  const dispatcher = new api.RpcDispatcher({
    methods: api.AI_VAULT_METHODS,
    runtime: { getRuntimeId: () => `file-id-${process.pid}` }
  })

  transport = new api.UnixSocketTransport({ endpoint, kind: 'named-pipe' })
  transport.onMessage((message, reply) => {
    void dispatcher
      .dispatch(JSON.parse(message))
      .then((response) => reply(JSON.stringify(response)))
  })
  await transport.start()
  record('rpc-transport', {
    endpoint,
    auth: 'fixture; production auth/metadata server not booted',
    methods: 'production AI_VAULT_METHODS',
    dispatcher: 'production RpcDispatcher'
  })

  const roots = {
    ...api.isolatedScanRoots(join(output, 'roots')),
    wslHomeDirs: [],
    additionalCodexSessionsDirs: [],
    executionHostId: 'local'
  }

  process.env.ORCA_FILE_ID_ROOTS = JSON.stringify(roots)
  await fs.mkdir(roots.claudeProjectsDir, { recursive: true })
  transcript = join(roots.claudeProjectsDir, `${sessionId}.jsonl`)

  if (phase === 'restart') {
    settings = JSON.parse(await fs.readFile(join(profile, 'fixture-settings.json'), 'utf8'))
    assert.equal(settings.aiVaultSearch.enabled, true)
    const beforeRestart = inspect(markers.replacement)
    registration = api.installChildSessionSearchService({
      dataRoot: profile,
      getSettings: () => settings
    })
    await waitFor((s) => s.filesIndexed === 1 && s.phase === 'current', 'Electron host restart')
    await query(markers.append, false)
    await query(markers.replacement, true)
    assert.deepEqual(inspect(markers.replacement), beforeRestart)
    record('app-host-restart-same-db')
    await disableAndCheck()

    return
  }

  const body = `${api.claudeLines([markers.initial], sessionId, 0).join('\n')}\n`
  await fs.writeFile(transcript, body)
  let raw = await fs.stat(transcript, { bigint: true })

  for (let n = 0; raw.ino <= BigInt(Number.MAX_SAFE_INTEGER) && n < 512; n++) {
    await fs.unlink(transcript)
    await fs.writeFile(transcript, body)
    raw = await fs.stat(transcript, { bigint: true })
  }

  assert.ok(raw.ino > BigInt(Number.MAX_SAFE_INTEGER), 'NTFS must supply an actual unsafe inode')
  record('fixture', {
    transcript,
    rawIno: raw.ino.toString(),
    numericIno: BigInt(Number(raw.ino)).toString()
  })
  registration = api.installChildSessionSearchService({
    dataRoot: profile,
    getSettings: () => settings
  })
  assert.ok(registration)
  assert.equal((await status()).enabled, false)
  assert.deepEqual(await api.rpc('aiVault.searchSessions', { query: markers.initial }), {
    kind: 'unavailable',
    reason: 'disabled'
  })
  assert.equal(existsSync(database), false)
  record('default-off')
  await policy({ aiVaultSearch: { enabled: true, historyDays: null } })

  const initial = await waitFor(
    (s) => s.filesIndexed === 1 && s.phase === 'current',
    'initial indexing'
  )

  assert.equal(inspect(markers.initial).file.ino, BigInt(Number(raw.ino)).toString())
  await query(markers.initial, true)
  record('initial-indexing', { status: initial })
  let recent = initial

  for (let n = 0; n < 2; n++) {
    const previous = recent
    recent = await waitFor(
      (s) => s.lastReconcileAt > previous.lastReconcileAt,
      'recent timer reconciliation'
    )
    assert.equal(
      recent.lastSweepCompletedAt,
      initial.lastSweepCompletedAt,
      'Expected a recent pass'
    )
    await query(markers.initial, true)
    record('recent-pass', { status: recent })
  }

  for (let n = 0; n < 2; n++) {
    await api.reconcileSessionSearchInService()
    await query(markers.initial, true)
    record('full-pass', { status: await status() })
  }

  await fs.appendFile(
    transcript,
    `${api.claudeLines([markers.append], sessionId, 10).join('\n')}\n`
  )
  const frozen = new Date(Math.floor((await fs.stat(transcript)).mtimeMs))
  await fs.utimes(transcript, frozen, frozen)
  await api.reconcileSessionSearchInService()
  await query(markers.append, true)
  const before = await fs.stat(transcript)
  const replacement = `${transcript}.replacement`

  const replacementBody = (await fs.readFile(transcript, 'utf8')).replaceAll(
    markers.append,
    markers.replacement
  )

  assert.equal(Buffer.byteLength(replacementBody), before.size)
  await fs.writeFile(replacement, replacementBody)
  await fs.rename(replacement, transcript)
  await fs.utimes(transcript, before.atime, before.mtime)
  const after = await fs.stat(transcript)
  assert.equal(after.size, before.size)
  assert.equal(after.mtimeMs, before.mtimeMs)
  assert.notEqual(after.ino, before.ino)
  await api.reconcileSessionSearchInService()
  await query(markers.append, false)
  await query(markers.replacement, true)
  record('replacement', { beforeIno: before.ino, afterIno: after.ino })
  await stopChild()
  await waitFor((s) => s.filesIndexed === 1 && s.phase === 'current', 'scanner restart')
  await query(markers.append, false)
  await query(markers.replacement, true)
  record('service-restart')
}

async function disableAndCheck() {
  await policy({ aiVaultSearch: { enabled: false, historyDays: null } })
  await waitFor((s) => !s.enabled, 'disable')
  const snapshot = inspect(markers.replacement)
  await fs.appendFile(
    transcript,
    `${api.claudeLines([markers.disabled], sessionId, 20).join('\n')}\n`
  )
  await api.reconcileSessionSearchInService()
  await sleep(21_000)
  assert.deepEqual(await api.rpc('aiVault.searchSessions', { query: markers.disabled }), {
    kind: 'unavailable',
    reason: 'disabled'
  })
  assert.deepEqual(inspect(markers.replacement), snapshot)
  assert.deepEqual(inspect(markers.disabled).sessions, [])
  record('disabled-no-indexing')
}

app.whenReady().then(async () => {
  try {
    await run()
    report.ok = true
  } catch (error) {
    report.ok = false
    report.error = error.stack
    console.error(error)
  } finally {
    registration?.dispose()
    await transport?.stop()

    if (api) {
      await stopChild().catch((error) => {
        report.cleanupError = String(error)
        report.ok = false
      })
    }

    if (report.stderr.some((text) => text.includes('[ai-vault-search]'))) {
      report.ok = false
    }

    await fs.writeFile(join(output, `report-${phase}.json`), JSON.stringify(report, null, 2))
    app.exit(report.ok ? 0 : 1)
  }
})
