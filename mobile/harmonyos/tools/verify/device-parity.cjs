const assert = require('node:assert/strict')
const { test } = require('node:test')
const { loadArkts } = require('./arkts-source.cjs')
const notificationIdentity = loadArkts('notifications/NotificationIdentity.ets', [
  'notificationFenceKey',
  'readNotificationIdentity'
])
const bytes = {
  base64Decode: (value) => Uint8Array.from(Buffer.from(value, 'base64'))
}
const deferred = () => {
  let resolve
  const promise = new Promise((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

test('notification permission keeps first request, system refusal and settings recovery distinct', async () => {
  let authorized = false
  let rememberedChoice = false
  let requestError = 1600003
  const settingsClosed = deferred()
  const permission = loadArkts(
    'notifications/NotificationPermission.ets',
    [
      'readNotificationPermission',
      'requestNotificationPermission',
      'openNotificationPermissionSettings'
    ],
    {
      KEY_NOTIFICATIONS_PERMISSION_DECIDED: 'notifications.permissionDecided',
      getBool: async () => rememberedChoice,
      setBool: async (_context, _key, value) => {
        rememberedChoice = value
      },
      notificationManager: {
        isNotificationEnabled: async () => authorized,
        requestEnableNotification: async () => {
          throw Object.assign(new Error('Notification request failed'), { code: requestError })
        },
        openNotificationSettingsWithResult: () => settingsClosed.promise
      }
    }
  )
  assert.equal(await permission.readNotificationPermission({}), 'undetermined')
  await assert.rejects(permission.requestNotificationPermission({}), /Notification request failed/)
  assert.equal(await permission.readNotificationPermission({}), 'undetermined')
  requestError = 1600004
  assert.equal(await permission.requestNotificationPermission({}), 'denied')
  assert.equal(await permission.readNotificationPermission({}), 'denied')
  const recovering = permission.openNotificationPermissionSettings({})
  authorized = true
  settingsClosed.resolve({ notificationEnabled: true })
  assert.equal(await recovering, 'granted')
  authorized = false
  assert.equal(await permission.readNotificationPermission({}), 'denied')
})

function speechHarness(createEngine) {
  return loadArkts('webshell/NativeSpeech.ets', ['NativeSpeech'], {
    speechRecognizer: { createEngine },
    canIUse: () => true,
    getString: async () => 'computer',
    KEY_DICTATION_ENGINE: 'dictation.engine'
  }).NativeSpeech
}

function recognizer() {
  let listener
  let active = ''
  const samples = []
  return {
    samples,
    setListener(next) {
      listener = next
    },
    isBusy: () => false,
    startListening({ sessionId }) {
      active = sessionId
      listener.onStart(active, '')
    },
    writeAudio(_id, chunk) {
      samples.push(Array.from(chunk))
    },
    finish(id) {
      listener.onResult(id, { result: 'recognized locally', isFinal: true, isLast: true })
      listener.onComplete(id, '')
    },
    cancel() {
      active = ''
    },
    shutdown() {
      active = ''
    }
  }
}

test('speech refuses a second pending start and cancellation cannot activate a stale engine', async () => {
  const pending = deferred()
  const engine = recognizer()
  let first = true
  const NativeSpeech = speechHarness(() => {
    if (first) {
      first = false
      return pending.promise
    }
    return Promise.resolve(engine)
  })
  const speech = new NativeSpeech({})
  const start = speech.serve({ action: 'start', locale: 'zh-CN' })
  assert.equal((await speech.serve({ action: 'start', locale: 'zh-CN' })).reason, 'busy')
  speech.cancel()
  pending.resolve(recognizer())
  assert.equal((await start).started, false)
  assert.equal((await speech.serve({ action: 'start', locale: 'zh-CN' })).started, true)
  speech.dispose()
})

test('speech finishes the captured PCM tail and returns the actual local transcript', async () => {
  const engine = recognizer()
  const NativeSpeech = speechHarness(async () => engine)
  const speech = new NativeSpeech({})
  await speech.serve({ action: 'start', locale: 'zh-CN' })
  speech.feed(Uint8Array.from([1, 2, 3]))
  const result = await speech.serve({ action: 'finish' })
  assert.equal(result.text, 'recognized locally')
  assert.equal(result.failure, null)
  assert.deepEqual(engine.samples[0].slice(0, 5), [1, 2, 3, 0, 0])
  const repeated = await speech.serve({ action: 'finish' })
  assert.equal(repeated.text, null)
  assert.equal(repeated.failure, 'failed')
  speech.dispose()
})

test('unsupported local speech reports its real availability without claiming a start', async () => {
  const NativeSpeech = speechHarness(async () => recognizer())
  const speech = new NativeSpeech({})
  const status = await speech.serve({ action: 'status', locale: 'en-US' })
  assert.equal(status.status, 'unsupported')
  assert.equal((await speech.serve({ action: 'start', locale: 'en-US' })).started, false)
  speech.dispose()
})

test('Simplified Chinese remains available after a busy speech service releases its engine', async () => {
  let busy = true
  const NativeSpeech = speechHarness(async () => {
    if (busy) {
      throw Object.assign(new Error('Speech service busy'), { code: 1002200006 })
    }
    return recognizer()
  })
  const speech = new NativeSpeech({})
  assert.equal((await speech.serve({ action: 'status', locale: 'zh-Hans-CN' })).status, 'busy')
  busy = false
  assert.equal((await speech.serve({ action: 'start', locale: 'zh-Hans-CN' })).started, true)
  speech.dispose()
})

class RpcSuccess {
  constructor(id, result) {
    this.id = id
    this.result = JSON.stringify(result)
  }
}
function pdfHarness(client, preview = {}) {
  const shown = []
  const removed = []
  let visible = null
  const fs = {
    open: async (path) => ({ path, fd: path }),
    close: async () => {},
    unlink: async (path) => {
      removed.push(path)
    },
    write: async (_fd, buffer) => buffer.byteLength,
    OpenMode: { CREATE: 1, TRUNC: 2, READ_WRITE: 4 }
  }
  const NativePdfViewer = loadArkts('webshell/NativePdfViewer.ets', ['NativePdfViewer'], {
    util: { generateRandomUUID: () => 'document' },
    fs,
    fileUri: { getUriFromPath: (path) => `file://${path}` },
    canIUse: () => Boolean(preview.load),
    pdfService: { ParseResult: { PARSE_SUCCESS: 0, PARSE_ERROR_PASSWORD: 3 } },
    pdfViewManager: {
      PdfController: class {
        loadDocument(path, password) {
          return preview.load(path, password)
        }
        releaseDocument() {}
      }
    },
    ...bytes,
    RpcSuccess,
    filePreview: {
      openPreview: async (_context, info) => {
        shown.push(info)
        await preview.open?.(info)
      },
      closePreview: async () => {
        await preview.close?.()
      }
    }
  }).NativePdfViewer
  const viewer = new NativePdfViewer(
    { cacheDir: '/cache' },
    client,
    (document) => {
      visible = document
    },
    preview.isActive
  )
  return { viewer, shown, removed, visible: () => visible }
}
function pdfClient(onRequest) {
  return {
    buildWire(id, method, params) {
      return JSON.stringify({ id, method, params: JSON.parse(params) })
    },
    cancelById() {},
    requestRaw: async (id, wire) => {
      const request = JSON.parse(wire)
      const answer = await onRequest(request)
      return new RpcSuccess(id, answer)
    }
  }
}
const pdfData = Buffer.from('%PDF-1.7')
const fileStat = { size: 8, isDirectory: false, mtime: 4 }
const fileChunk = { contentBase64: pdfData.toString('base64'), bytesRead: 8, eof: true }

test('a newer PDF open cancels an older download and keeps remote execution scope', async () => {
  const oldRead = deferred()
  const oldReached = deferred()
  const envelopes = []
  const client = pdfClient(async (request) => {
    envelopes.push(request.executionHost)
    if (request.params.relativePath === 'old.pdf') {
      oldReached.resolve()
      return oldRead.promise
    }
    return request.method === 'files.stat' ? fileStat : fileChunk
  })
  const { viewer, shown } = pdfHarness(client)
  const old = viewer.serve({
    action: 'open',
    worktreeId: 'w',
    relativePath: 'old.pdf',
    executionHost: 'runtime:remote'
  })
  const rejected = assert.rejects(old, /cancelled/)
  await oldReached.promise
  await viewer.serve({
    action: 'open',
    worktreeId: 'w',
    relativePath: 'new.pdf',
    executionHost: 'runtime:remote'
  })
  oldRead.resolve(fileStat)
  await rejected
  assert.equal(shown[0].title, 'new.pdf')
  assert.ok(envelopes.every((scope) => scope === 'runtime:remote'))
  await viewer.dispose()
})

test('leaving while a PDF presentation is pending closes the preview and removes its cached file', async () => {
  const presented = deferred()
  const finishPresent = deferred()
  let visible = false
  const client = pdfClient(async (request) =>
    request.method === 'files.stat' ? fileStat : fileChunk
  )
  const { viewer, removed } = pdfHarness(client, {
    open: async () => {
      presented.resolve()
      await finishPresent.promise
      visible = true
    },
    close: async () => {
      visible = false
    }
  })
  const opened = viewer.serve({ action: 'open', worktreeId: 'w', relativePath: 'new.pdf' })
  const rejected = assert.rejects(opened, /cancelled/)
  await presented.promise
  const cancelled = viewer.serve({ action: 'cancel' })
  finishPresent.resolve()
  await Promise.all([rejected, cancelled])
  assert.equal(visible, false)
  assert.ok(removed.some((path) => path.endsWith('.pdf')))
})

test('system preview can finish opening its PDF after Orca is backgrounded', async () => {
  const presenting = deferred()
  const finishPresent = deferred()
  let visible = false
  const client = pdfClient(async (request) =>
    request.method === 'files.stat' ? fileStat : fileChunk
  )
  const { viewer, removed } = pdfHarness(client, {
    open: async ({ uri }) => {
      presenting.resolve(new URL(uri).pathname)
      await finishPresent.promise
      visible = true
    },
    close: async () => {
      visible = false
    }
  })
  const opened = viewer.serve({ action: 'open', worktreeId: 'w', relativePath: 'new.pdf' })
  const previewPath = await presenting.promise
  const paused = viewer.pause()
  finishPresent.resolve()
  await Promise.all([paused, opened])
  await viewer.pause()
  assert.equal(visible, true)
  assert.equal(removed.includes(previewPath), false)
  await viewer.dispose()
  assert.equal(visible, false)
  assert.equal(removed.includes(previewPath), true)
})

test('closing the page during in-app PDF parsing cannot replace the visible document', async () => {
  const parsing = deferred()
  const parsed = deferred()
  const client = pdfClient(async (request) =>
    request.method === 'files.stat' ? fileStat : fileChunk
  )
  const { viewer, visible, removed } = pdfHarness(client, {
    load: async (path) => {
      parsing.resolve(path)
      return parsed.promise
    }
  })
  const opening = viewer.serve({ action: 'open', worktreeId: 'w', relativePath: 'new.pdf' })
  const rejected = assert.rejects(opening, /cancelled/)
  const path = await parsing.promise
  const closing = viewer.serve({ action: 'cancel' })
  parsed.resolve(0)
  await Promise.all([rejected, closing])
  assert.equal(visible(), null)
  assert.ok(removed.includes(path))
})

test('a protected PDF can be retried in Orca until the viewer closes', async () => {
  const client = pdfClient(async (request) =>
    request.method === 'files.stat' ? fileStat : fileChunk
  )
  const { viewer, visible, removed } = pdfHarness(client, {
    load: async (_path, password) => (password === 'fixture passphrase' ? 0 : 3)
  })
  await viewer.serve({ action: 'open', worktreeId: 'w', relativePath: 'protected.pdf' })
  const preview = visible()
  assert.equal(preview.title, 'protected.pdf')
  assert.equal(preview.controller, null)
  assert.equal(await preview.unlock('wrong passphrase'), null)
  await viewer.pause()
  assert.equal(visible(), preview)
  assert.equal(removed.includes(preview.path), false)
  assert.ok(await preview.unlock('fixture passphrase'))
  assert.equal(removed.includes(preview.path), false)
  await viewer.serve({ action: 'cancel' })
  assert.equal(visible(), null)
  assert.ok(removed.includes(preview.path))
  await assert.rejects(preview.unlock('fixture passphrase'), /cancelled/)
})

function preferencesHarness() {
  const values = new Map()
  let fail = false
  const store = {
    get: async (key, fallback) => (values.has(key) ? values.get(key) : fallback),
    getSync: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
    hasSync: (key) => values.has(key),
    putSync: (key, value) => {
      values.set(key, value)
    },
    deleteSync: (key) => values.delete(key),
    flushSync() {
      if (fail) {
        throw new Error('disk full')
      }
    }
  }
  const api = loadArkts(
    'settings/SettingsStore.ets',
    [
      'setString',
      'setNumber',
      'getString',
      'getNumber',
      'getBool',
      'setBool',
      'notificationDeliveryEnabled',
      'readPagePreferencesSync',
      'writePagePreferenceSync'
    ],
    {
      preferences: { getPreferencesSync: () => store, getPreferences: async () => store }
    }
  )
  return {
    ...api,
    fail: (value) => {
      fail = value
    }
  }
}

test('native settings and page settings share accepted values and failed saves retain the old value', async () => {
  const settings = preferencesHarness()
  await settings.setNumber({}, 'orca:terminalTextScale', 1.5)
  assert.equal(settings.readPagePreferencesSync({}).get('orca:terminalTextScale'), '1.5')
  settings.writePagePreferenceSync({}, 'orca:terminalTextScale', '0.75')
  assert.equal(await settings.getNumber({}, 'orca:terminalTextScale'), 0.75)
  await settings.setString({}, 'orca:defaultSessionView', 'chat')
  settings.fail(true)
  await assert.rejects(settings.setString({}, 'orca:defaultSessionView', 'terminal'), /disk full/)
  assert.equal(await settings.getString({}, 'orca:defaultSessionView'), 'chat')
})

function imageHarness(extra = {}) {
  const copied = []
  const NativeImageActions = loadArkts('webshell/NativeImageActions.ets', ['NativeImageActions'], {
    util: { generateRandomUUID: () => 'document' },
    ...bytes,
    base64Encode: (value) => Buffer.from(value).toString('base64'),
    pasteboard: {
      MIMETYPE_PIXELMAP: 'pixel',
      createData: (mime, pixel) => ({ mime, pixel }),
      getSystemPasteboard: () => ({
        setData: async (value) => {
          copied.push(value)
        }
      })
    },
    image: {
      createImageSource: () => ({
        getImageInfo: async () => ({ size: { width: 1, height: 1 } }),
        createPixelMap: async () => ({ release: async () => {} }),
        release() {}
      })
    },
    ...extra
  }).NativeImageActions
  return { actions: new NativeImageActions({ cacheDir: '/cache' }), copied }
}

test('image chunks must continue the staged image before it can be copied', async () => {
  const { actions, copied } = imageHarness()
  await actions.serve({ action: 'stage', offset: 0, base64: 'iVBORw==' })
  await assert.rejects(actions.serve({ action: 'stage', offset: 8, base64: 'AA==' }), /range/)
  await assert.rejects(
    actions.serve({
      action: 'run',
      operation: 'copy',
      source: { kind: 'staged', mime: 'image/png', byteLength: 4 }
    }),
    /source/
  )
  await actions.serve({ action: 'stage', offset: 0, base64: 'iVBORw==' })
  await actions.serve({
    action: 'run',
    operation: 'copy',
    source: { kind: 'staged', mime: 'image/png', byteLength: 4 }
  })
  assert.equal(copied[0].mime, 'pixel')
  actions.dispose()
})

test('saving an image rejects a partial write to the authorized photo asset', async () => {
  const { actions } = imageHarness({
    fs: {
      OpenMode: { CREATE: 1, TRUNC: 2, READ_WRITE: 4, WRITE_ONLY: 8 },
      mkdirSync() {},
      rmdirSync() {},
      openSync: () => ({ fd: 1 }),
      writeSync: () => 4,
      closeSync() {},
      open: async () => ({ fd: 2 }),
      write: async () => 2,
      close: async () => {}
    },
    fileUri: { getUriFromPath: (path) => `file://${path}` },
    photoAccessHelper: {
      PhotoType: { IMAGE: 1 },
      getPhotoAccessHelper: () => ({
        showAssetsCreationDialog: async () => ['file://media/Photo/1/image.png'],
        release: async () => {}
      })
    }
  })
  await actions.serve({ action: 'stage', offset: 0, base64: 'iVBORw==' })
  await assert.rejects(
    actions.serve({
      action: 'run',
      operation: 'save',
      source: { kind: 'staged', mime: 'image/png', byteLength: 4 }
    }),
    /Image save failed/
  )
  actions.dispose()
})

test('leaving an image page during download prevents a later clipboard write', async () => {
  const download = deferred()
  const { actions, copied } = imageHarness({
    http: {
      createHttp: () => ({ request: () => download.promise, destroy() {} }),
      HttpDataType: { ARRAY_BUFFER: 1 }
    }
  })
  const run = actions.serve({
    action: 'run',
    operation: 'copy',
    source: { kind: 'url', url: 'https://images.example/image.png' }
  })
  const rejection = assert.rejects(run, /closed/)
  actions.pause()
  download.resolve({
    responseCode: 200,
    result: new ArrayBuffer(8),
    header: { 'content-type': 'image/png' }
  })
  await rejection
  assert.deepEqual(copied, [])
})

test('desktop notifications retain pane and execution scope and ignore replays or events after stop', () => {
  let receive
  const delivered = []
  const { AgentWatch } = loadArkts(
    'notifications/AgentWatch.ets',
    ['AgentWatch'],
    notificationIdentity
  )
  const watch = new AgentWatch({
    deviceToken: 'test-token',
    hostId: 'host',
    subscribe(_id, wire, callback) {
      assert.equal(JSON.parse(wire).method, 'notifications.subscribe')
      receive = callback
      return true
    },
    cancel() {},
    logSink() {},
    notify(...args) {
      delivered.push(args)
      return true
    }
  })
  watch.start()
  const event = JSON.stringify({
    streaming: true,
    result: {
      type: 'notification',
      source: 'terminal-bell',
      title: 'Terminal attention',
      body: 'Bell',
      notificationEpoch: 'epoch',
      notificationSeq: 3,
      worktreeId: 'workspace',
      paneKey: 'terminal:pane',
      executionHost: 'runtime:remote'
    }
  })
  receive(event)
  receive(event)
  assert.deepEqual(delivered, [
    ['Terminal attention', 'Bell', 'host', 'workspace', 'terminal:pane', 'runtime:remote']
  ])
  watch.stop()
  receive(
    JSON.stringify({
      streaming: true,
      result: {
        type: 'notification',
        source: 'terminal-bell',
        title: 'Stopped',
        body: '',
        notificationEpoch: 'epoch',
        notificationSeq: 4
      }
    })
  )
  assert.equal(delivered.length, 1)
})

function notifierHarness(settings = {}, options = {}) {
  const requests = []
  const cancelled = []
  const prefs = {
    onlyWhenDesktopAway: true,
    onlyWhenAgentNeedsInput: false,
    sound: true,
    suppressWhileViewing: true,
    ...settings
  }
  const { LocalNotifier } = loadArkts('notifications/LocalNotifier.ets', ['LocalNotifier'], {
    ...notificationIdentity,
    getBool: options.getBool ?? (async (_context, key) => key === 'enabled'),
    notificationDeliveryEnabled: options.notificationDeliveryEnabled ?? (() => true),
    KEY_NOTIFICATIONS_LOCAL_ENABLED: 'enabled',
    KEY_NOTIFICATIONS_DND_ENABLED: 'dnd',
    notificationDeliveryPreferences: () => ({ ...prefs }),
    notificationManager: {
      isNotificationEnabled: async () => true,
      isNotificationEnabledSync: () => true,
      addSlot: async () => {},
      publish: async (request) => {
        options.onPublish?.()
        requests.push(request)
      },
      getActiveNotifications: async () =>
        requests.filter((request) => !cancelled.includes(request.id)),
      cancel: async (id) => {
        cancelled.push(id)
      },
      SlotType: { SOCIAL_COMMUNICATION: 1 }
    },
    notification: {
      ContentType: { NOTIFICATION_CONTENT_BASIC_TEXT: 0 },
      SlotType: { SOCIAL_COMMUNICATION: 1 }
    },
    wantAgent: {
      getWantAgent: options.getWantAgent ?? (async (value) => value),
      OperationType: { START_ABILITY: 0 },
      WantAgentFlags: { UPDATE_PRESENT_FLAG: 0 }
    }
  })
  const createNotifier = () => {
    const notifier = new LocalNotifier()
    notifier.setContext({ abilityInfo: { bundleName: 'example.orca', name: 'MainAbility' } })
    return notifier
  }
  return { notifier: createNotifier(), createNotifier, requests, cancelled, prefs }
}
const notificationEvent = {
  title: 'Agent event',
  body: 'Needs input',
  hostId: 'host',
  worktreeId: 'workspace',
  paneKey: 'terminal:pane',
  executionHost: 'runtime:remote',
  source: 'agent-task-complete',
  agentState: 'waiting',
  desktopAway: true,
  identity: { notificationId: 'event', notificationEpoch: 'one', notificationSeq: 4 }
}

test('notification delivery filters desktop activity, finished agents and the visible execution host', async () => {
  const { notifier, requests } = notifierHarness({ onlyWhenAgentNeedsInput: true, sound: false })
  assert.equal(
    await notifier.publishDesktopEventAsync({ ...notificationEvent, desktopAway: false }),
    false
  )
  assert.equal(
    await notifier.publishDesktopEventAsync({ ...notificationEvent, agentState: 'done' }),
    false
  )
  notifier.setViewing('host', 'workspace', 'runtime:remote')
  assert.equal(await notifier.publishDesktopEventAsync(notificationEvent), false)
  notifier.setViewing('host', 'workspace', '')
  assert.equal(await notifier.publishDesktopEventAsync(notificationEvent), true)
  assert.equal(requests[0].notificationFlags.soundEnabled, 2)
  assert.equal(requests[0].wantAgent.wants[0].bundleName, 'example.orca')
  assert.match(
    requests[0].wantAgent.wants[0].uri,
    /paneKey=terminal%3Apane&executionHost=runtime%3Aremote/
  )
  await notifier.dismiss('host', notificationEvent.identity)
  assert.equal(await notifier.publishDesktopEventAsync(notificationEvent), false)
})

test('a dismissal received before a notification finishes publishing cannot leave a stale alert', async () => {
  const { notifier, requests } = notifierHarness()
  const published = notifier.publishDesktopEventAsync(notificationEvent)
  await notifier.dismiss('host', notificationEvent.identity)
  assert.equal(await published, false)
  assert.deepEqual(requests, [])
})

test('reconnecting withdraws only the dismissed desktop receipt from the tray after a restart', async () => {
  const { notifier, createNotifier, requests, cancelled } = notifierHarness()
  const next = {
    ...notificationEvent,
    identity: { ...notificationEvent.identity, notificationSeq: 6 }
  }
  const other = { ...notificationEvent, hostId: 'other-desktop' }
  for (const event of [notificationEvent, next, other]) {
    assert.equal(await notifier.publishDesktopEventAsync(event), true)
  }
  const restarted = createNotifier()
  await restarted.reconcile(
    'host',
    async (receipts) => {
      assert.deepEqual(
        Array.from(receipts, (receipt) => receipt.notificationSeq),
        [4, 6]
      )
      return [notificationEvent.identity]
    },
    () => true
  )
  assert.deepEqual(cancelled, [requests[0].id])
  await restarted.dismiss('host', { ...notificationEvent.identity, notificationSeq: 5 })
  assert.deepEqual(cancelled, [requests[0].id])
  assert.equal(
    await restarted.publishDesktopEventAsync({
      ...next,
      identity: { ...next.identity, notificationSeq: 7 }
    }),
    true
  )
})

test('old-host notification fallback treats a continuing interactive prompt as one input-needed transition', () => {
  let receive
  const delivered = []
  const { AgentWatch } = loadArkts(
    'notifications/AgentWatch.ets',
    ['AgentWatch'],
    notificationIdentity
  )
  const watch = new AgentWatch({
    deviceToken: 'test-token',
    hostId: 'host',
    subscribe(_id, _wire, callback) {
      receive = callback
      return true
    },
    cancel() {},
    logSink() {},
    notify() {
      return true
    },
    notifyEvent(event) {
      delivered.push(event)
      return true
    }
  })
  watch.start()
  receive(JSON.stringify({ error: { code: 'method-not-found' } }))
  const frame = (status) =>
    JSON.stringify({
      streaming: true,
      result: { type: 'updated', worktree: 'workspace', tabs: [{ id: 'tab', agentStatus: status }] }
    })
  receive(frame({ state: 'working' }))
  receive(frame({ state: 'working', interactivePrompt: 'permission request' }))
  receive(frame({ state: 'working', interactivePrompt: 'permission request' }))
  assert.deepEqual(
    delivered.map((event) => [event.worktreeId, event.agentState]),
    [['workspace', 'waiting']]
  )
  watch.stop()
})

function deviceHarness(extra = {}) {
  class Speech {
    cancel() {}
    dispose() {}
    feed() {}
  }
  class Images {
    pause() {}
    dispose() {}
  }
  class Pdf {
    async pause() {}
    async dispose() {}
  }
  const { NativeDevice } = loadArkts('webshell/NativeDevice.ets', ['NativeDevice'], {
    NativeSpeech: Speech,
    NativeImageActions: Images,
    NativePdfViewer: Pdf,
    ...extra
  })
  return new NativeDevice(
    extra.context ?? {},
    null,
    () => {},
    extra.onClipboardPrompt,
    extra.isActive
  )
}

test('a cancelled clipboard prompt leaves the next paste available for explicit confirmation', async () => {
  let prompt
  const device = deviceHarness({
    onClipboardPrompt: (next) => {
      prompt = next
    },
    pasteboard: {
      MIMETYPE_TEXT_PLAIN: 'text/plain',
      getSystemPasteboard: () => ({
        hasDataType: () => true,
        getData: async () => ({ getPrimaryText: () => 'Copied fixture text' })
      })
    }
  })
  const first = device.serve('native.clipboard.read', { mime: 'text' })
  const refused = assert.rejects(first, /Clipboard paste cancelled/)
  const cancelled = prompt
  cancelled.cancel()
  await refused
  const retry = device.serve('native.clipboard.read', { mime: 'text' })
  await cancelled.confirm()
  await prompt.confirm()
  assert.equal((await retry).value, 'Copied fixture text')
  await device.dispose()
})

test('a media picker returning after the page is paused cannot publish staged media handles', async () => {
  const selected = deferred()
  const device = deviceHarness({
    photoAccessHelper: {
      PhotoSelectOptions: class {},
      PhotoViewMIMETypes: { IMAGE_TYPE: 'image' },
      PreferredCompatibleMode: { COMPATIBLE: 2 },
      PhotoViewPicker: class {
        select() {
          return selected.promise
        }
      }
    },
    fs: {
      open() {
        throw new Error('stale selection opened a file')
      }
    }
  })
  const picking = device.serve('native.media.pick', { source: 'library', multiple: false })
  const refused = assert.rejects(picking, /Selection cancelled/)
  await device.pause()
  selected.resolve({ photoUris: ['file://selected/image.png'] })
  await refused
  assert.equal((await device.serve('native.media.name', { handle: 'media-1' })).name, null)
  await device.dispose()
})

test('a HEIF photo returned by the library is staged as JPEG for the attachment bridge', async () => {
  const original = Buffer.from('0000001466747970686569630000000068656963', 'hex')
  const device = deviceHarness({
    photoAccessHelper: {
      PhotoSelectOptions: class {},
      PhotoViewMIMETypes: { IMAGE_TYPE: 'image' },
      PreferredCompatibleMode: { COMPATIBLE: 2 },
      PhotoViewPicker: class {
        async select() {
          return { photoUris: ['file://selected/photo.heic'] }
        }
      }
    },
    fs: {
      OpenMode: { READ_ONLY: 0 },
      open: async () => ({ fd: 1 }),
      stat: async () => ({ size: original.length }),
      read: async (_fd, buffer) => {
        new Uint8Array(buffer).set(original)
        return original.length
      },
      close: async () => {}
    },
    image: {
      createImageSource: () => ({
        getImageInfo: async () => ({ size: { width: 800, height: 560 } }),
        release: async () => {}
      }),
      createImagePacker: () => ({
        packToData: async () => Uint8Array.of(255, 216, 255, 217).buffer,
        release: async () => {}
      })
    },
    base64Encode: (value) => Buffer.from(value).toString('base64')
  })
  const { items } = await device.serve('native.media.pick', { source: 'library', multiple: false })
  const [{ handle }] = items
  assert.equal(items[0].mime, 'image/jpeg')
  assert.equal((await device.serve('native.media.name', { handle })).name, 'photo.jpg')
  assert.equal(
    (await device.serve('native.media.read', { handle, offset: 0, length: 32 })).base64,
    '/9j/2Q=='
  )
  await device.dispose()
})

test('external link handling refuses executable and file URLs and opens accepted browser URLs through the OS', async () => {
  const opened = []
  const device = deviceHarness({
    context: {
      startAbility: async (want) => {
        opened.push(want.uri)
      }
    }
  })
  await assert.rejects(device.notifyExternalLink('javascript:alert(1)'), /Invalid external/)
  await assert.rejects(device.notifyExternalLink('file:///private/credentials'), /Invalid external/)
  await device.notifyExternalLink('https://example.com/page?q=value')
  assert.deepEqual(opened, ['https://example.com/page?q=value'])
  await device.dispose()
})

function microphoneBindings(capturer, recordingWindow) {
  return {
    readDictationEngine: async () => 'automatic',
    DICTATION_ENGINE_ONDEVICE: 'phone',
    abilityAccessCtrl: {
      createAtManager: () => ({ requestPermissionsFromUser: async () => ({ authResults: [0] }) })
    },
    window: { getLastWindow: async () => recordingWindow },
    audio: {
      createAudioCapturer: async () => capturer,
      AudioSamplingRate: { SAMPLE_RATE_16000: 16000 },
      AudioChannel: { CHANNEL_1: 1 },
      AudioSampleFormat: { SAMPLE_FORMAT_S16LE: 1 },
      AudioEncodingType: { ENCODING_TYPE_RAW: 0 },
      SourceType: { SOURCE_TYPE_MIC: 1 },
      AudioState: { STATE_STOPPED: 3, STATE_RELEASED: 4, STATE_PAUSED: 5 },
      InterruptType: { INTERRUPT_TYPE_BEGIN: 1 },
      InterruptHint: { INTERRUPT_HINT_PAUSE: 2, INTERRUPT_HINT_STOP: 3, INTERRUPT_HINT_DUCK: 4 }
    },
    base64Encode: (value) => Buffer.from(value).toString('base64')
  }
}

test('phone-only audio reaches the local recognizer while the page receives no samples', async () => {
  let read
  let armed = false
  const localAudio = []
  const device = deviceHarness({
    ...microphoneBindings(
      {
        on(name, callback) {
          if (name === 'readData') {
            read = callback
          }
        },
        off() {},
        start: async () => {},
        stop: async () => {},
        release: async () => {}
      },
      {
        getWindowProperties: () => ({ isKeepScreenOn: false }),
        setWindowKeepScreenOn: async () => {}
      }
    ),
    readDictationEngine: async () => 'phone',
    NativeSpeech: class {
      canCapture() {
        return armed
      }
      feed(samples) {
        localAudio.push(Array.from(samples))
      }
      dispose() {}
    }
  })
  const unavailable = await device.serve('native.audio.start', { sampleRate: 16000 })
  assert.equal(unavailable.started, false)
  assert.equal(unavailable.permission, 'granted')
  armed = true
  assert.equal((await device.serve('native.audio.start', { sampleRate: 16000 })).started, true)
  read(Uint8Array.from([3, 1, 4, 1]).buffer)
  assert.deepEqual(localAudio, [[3, 1, 4, 1]])
  assert.equal((await device.serve('native.audio.read', { maxBytes: 128 })).base64, '')
  assert.equal((await device.serve('native.audio.stop', {})).base64, '')
  await device.dispose()
})

test('pausing while the microphone wake lock is pending cannot begin capture or leave the screen awake', async () => {
  const locking = deferred()
  const lockReached = deferred()
  let capturing = false
  let awake = false
  const capturer = {
    on() {},
    off() {},
    async start() {
      capturing = true
    },
    async stop() {
      capturing = false
    },
    async release() {
      capturing = false
    }
  }
  const recordingWindow = {
    getWindowProperties: () => ({ isKeepScreenOn: false }),
    async setWindowKeepScreenOn(value) {
      if (value) {
        lockReached.resolve()
        await locking.promise
      }
      awake = value
    }
  }
  const device = deviceHarness(microphoneBindings(capturer, recordingWindow))
  const start = device.serve('native.audio.start', { sampleRate: 16000 })
  const cancelled = assert.rejects(start, /Capture cancelled/)
  await lockReached.promise
  await device.pause()
  locking.resolve()
  await cancelled
  assert.equal(capturing, false)
  assert.equal(awake, false)
  assert.equal((await device.serve('native.audio.read', { maxBytes: 128 })).recording, false)
  await device.dispose()
})

for (const loss of ['focus', 'stopped', 'background']) {
  test(`microphone loss through ${loss} preserves the local transcript and allows a fresh recording`, async () => {
    const listeners = new Map()
    const capturer = {
      on(name, callback) {
        listeners.set(name, callback)
      },
      off() {},
      async start() {},
      async stop() {},
      async release() {}
    }
    const recordingWindow = {
      getWindowProperties: () => ({ isKeepScreenOn: false }),
      async setWindowKeepScreenOn() {}
    }
    const engine = recognizer()
    const finalAudio = deferred()
    const complete = engine.finish
    engine.finish = (id) => {
      void finalAudio.promise.then(() => complete(id))
    }
    const device = deviceHarness({
      ...microphoneBindings(capturer, recordingWindow),
      NativeSpeech: speechHarness(async () => engine)
    })
    const startSpeech = () =>
      device.serve('native.speech.act', { action: 'start', locale: 'zh-CN' })
    const startAudio = () => device.serve('native.audio.start', { sampleRate: 16000 })
    const finishSpeech = () => device.serve('native.speech.act', { action: 'finish' })
    const readAudio = () => device.serve('native.audio.read', { maxBytes: 128 })
    assert.equal((await startSpeech()).started, true)
    assert.equal((await startAudio()).started, true)
    if (loss === 'focus') {
      listeners.get('audioInterrupt')({ eventType: 1, hintType: 4 })
      assert.equal((await readAudio()).recording, true)
    }
    listeners.get('readData')(Uint8Array.of(3, 1, 4, 1).buffer)
    if (loss === 'focus') {
      listeners.get('audioInterrupt')({ eventType: 1, hintType: 2 })
    } else if (loss === 'stopped') {
      listeners.get('stateChange')(3)
    } else {
      await device.pause()
    }
    const chunk = await readAudio()
    assert.equal(chunk.recording, false)
    assert.equal(chunk.interruption, loss === 'focus' ? 'began' : 'blocked')
    assert.equal(chunk.base64, 'AwEEAQ==')
    await device.serve('native.audio.stop', {})
    const finish = finishSpeech()
    finalAudio.resolve()
    assert.equal((await finish).text, 'recognized locally')
    assert.equal((await finishSpeech()).text, null)
    assert.equal((await startSpeech()).started, true)
    assert.equal((await startAudio()).started, true)
    await device.serve('native.speech.act', { action: 'cancel' })
    await device.serve('native.audio.stop', {})
    assert.equal((await finishSpeech()).text, null)
    await device.dispose()
  })
}

for (const change of ['disabled', 'dnd', 'viewing']) {
  test(`a notification suppressed by ${change} while preparing its launch target is not delivered`, async () => {
    const preparing = deferred()
    const prepared = deferred()
    const settings = preferencesHarness()
    const { notifier, requests } = notifierHarness(
      {},
      {
        getBool: (_context, key) =>
          settings.getBool(
            {},
            key === 'enabled' ? 'notifications.localEnabled' : 'notifications.dndEnabled'
          ),
        notificationDeliveryEnabled: () => settings.notificationDeliveryEnabled({}),
        getWantAgent: () => {
          preparing.resolve()
          return prepared.promise
        }
      }
    )
    const delivery = notifier.publishDesktopEventAsync(notificationEvent)
    await preparing.promise
    if (change === 'disabled') {
      await settings.setBool({}, 'notifications.localEnabled', false)
    } else if (change === 'dnd') {
      await settings.setBool({}, 'notifications.dndEnabled', true)
    } else {
      notifier.setViewing('host', 'workspace', 'runtime:remote')
    }
    prepared.resolve({})
    assert.equal(await delivery, false)
    assert.deepEqual(requests, [])
  })
}

test('an alert uses the sound preference selected while its launch target is being prepared', async () => {
  const preparing = deferred()
  const prepared = deferred()
  const { notifier, requests, prefs } = notifierHarness(
    {},
    {
      getWantAgent: () => {
        preparing.resolve()
        return prepared.promise
      }
    }
  )
  const delivery = notifier.publishDesktopEventAsync(notificationEvent)
  await preparing.promise
  prefs.sound = false
  prepared.resolve({})
  assert.equal(await delivery, true)
  assert.equal(requests[0].notificationFlags.soundEnabled, 2)
})

test('a covered shell cannot acquire native devices but can finish releasing its existing capture', async () => {
  let visible = true
  let recording = false
  const device = deviceHarness({
    ...microphoneBindings(
      {
        on() {},
        off() {},
        async start() {
          recording = true
        },
        async stop() {
          recording = false
        },
        async release() {
          recording = false
        }
      },
      {
        getWindowProperties: () => ({ isKeepScreenOn: false }),
        async setWindowKeepScreenOn() {}
      }
    ),
    isActive: () => visible,
    NativeSpeech: class {
      endInput() {}
      dispose() {}
      async serve() {
        return { text: 'retained transcript' }
      }
    },
    NativePdfViewer: class {
      async cancel() {}
      async dispose() {}
      async serve() {
        return {}
      }
    }
  })
  assert.equal((await device.serve('native.audio.start', { sampleRate: 16000 })).started, true)
  visible = false
  await device.pause(true)
  for (const [method, params] of [
    ['native.audio.start', { sampleRate: 16000 }],
    ['native.media.pick', { source: 'files', multiple: false }],
    ['native.pdf.view', { action: 'open', worktreeId: 'w', relativePath: 'secret.pdf' }],
    ['native.speech.act', { action: 'start', locale: 'zh-CN' }],
    ['native.clipboard.read', { mime: 'text' }],
    ['native.clipboard.write', { mime: 'text', value: 'stale page' }],
    [
      'native.image.act',
      {
        action: 'run',
        operation: 'share',
        source: { kind: 'url', url: 'https://example.com/a.png' }
      }
    ]
  ]) {
    await assert.rejects(device.serve(method, params), /page is not active/)
  }
  assert.equal(recording, false)
  assert.equal((await device.serve('native.audio.stop', {})).stopped, false)
  assert.equal(
    (await device.serve('native.speech.act', { action: 'finish' })).text,
    'retained transcript'
  )
  await device.serve('native.pdf.view', { action: 'cancel' })
  visible = true
  assert.equal((await device.serve('native.audio.start', { sampleRate: 16000 })).started, true)
  await device.dispose()
})

test('losing navigation ownership during microphone permission cannot acquire a capturer', async () => {
  const permission = deferred()
  const requesting = deferred()
  let visible = true
  let captured = false
  const bindings = microphoneBindings({}, {})
  bindings.abilityAccessCtrl.createAtManager = () => ({
    requestPermissionsFromUser: () => {
      requesting.resolve()
      return permission.promise
    }
  })
  bindings.audio.createAudioCapturer = async () => {
    captured = true
    throw new Error('A covered page requested microphone capture')
  }
  const device = deviceHarness({ ...bindings, isActive: () => visible })
  const opening = device.serve('native.audio.start', { sampleRate: 16000 })
  const cancelled = assert.rejects(opening, /Capture cancelled/)
  await requesting.promise
  visible = false
  permission.resolve({ authResults: [0] })
  await cancelled
  assert.equal(captured, false)
  await device.dispose()
})

test('a PDF download finishing after navigation ownership changes cannot present its preview', async () => {
  let visible = true
  const downloading = deferred()
  const downloaded = deferred()
  const client = pdfClient(async (request) => {
    if (request.method === 'files.stat') {
      return fileStat
    }
    downloading.resolve()
    await downloaded.promise
    return fileChunk
  })
  const { viewer, shown, removed } = pdfHarness(client, { isActive: () => visible })
  const opening = viewer.serve({ action: 'open', worktreeId: 'w', relativePath: 'pending.pdf' })
  const cancelled = assert.rejects(opening, /PDF page is not active/)
  await downloading.promise
  visible = false
  downloaded.resolve()
  await cancelled
  assert.deepEqual(shown, [])
  assert.ok(removed.some((path) => path.endsWith('.pdf')))
})

test('a queued preference change cannot interleave between the final delivery snapshot and native publication', async () => {
  let enabled = true
  let prepared = false
  let allowedAtPublication = null
  const snapshot = () => {
    const current = enabled
    if (prepared) {
      queueMicrotask(() => {
        enabled = false
      })
    }
    return current
  }
  const { notifier } = notifierHarness(
    {},
    {
      notificationDeliveryEnabled: snapshot,
      getBool: async (_context, key) => (key === 'enabled' ? snapshot() : false),
      getWantAgent: async () => {
        prepared = true
        return {}
      },
      onPublish: () => {
        allowedAtPublication = enabled
      }
    }
  )
  assert.equal(await notifier.publishDesktopEventAsync(notificationEvent), true)
  assert.equal(allowedAtPublication, true)
})
