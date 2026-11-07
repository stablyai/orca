import type { MessagePortMain } from 'electron'
import { speechEngineForModelFiles } from '../../shared/speech-model-engine'
import type { SpeechAudioPortMessage } from '../../shared/speech-types'
import type { SttRecognizer, SttRecognizerInit, SttRecognizerPost } from './stt-recognizer'
import { createSherpaRecognizer } from './stt-sherpa-recognizer'
import { createTranscribeCppRecognizer } from './stt-transcribe-cpp-recognizer'
import { connectSttWorkerParentPort } from './stt-worker-parent-port'
import type { SttWorkerRequest } from './stt-worker-process'

// A desktop renderer's audio for one stream, posted straight here instead of through main.
type AudioPortInput = {
  port: MessagePortMain
  onEnded: (() => void) | null
}

const parentPort = connectSttWorkerParentPort()
let recognizer: SttRecognizer | null = null
const audioPorts = new Map<string, AudioPortInput>()

// transcribe-cpp decodes off the event loop; one queue keeps feeds behind init and stop behind feeds.
let queue: Promise<void> = Promise.resolve()
function enqueue(task: () => void | Promise<void>): void {
  queue = queue.then(task)
}

async function handleInit(init: SttRecognizerInit): Promise<void> {
  try {
    const post: SttRecognizerPost = (event) => parentPort.post(event)
    recognizer =
      speechEngineForModelFiles(init.files) === 'transcribe-cpp'
        ? await createTranscribeCppRecognizer(init, post)
        : createSherpaRecognizer(init, post)
    parentPort.post({ type: 'ready' })
  } catch (err) {
    parentPort.post({ type: 'error', error: String(err) })
  }
}

async function handleFeed(msg: Extract<SttWorkerRequest, { type: 'feed' }>): Promise<void> {
  try {
    await recognizer?.feed(msg.streamId, msg.samples, msg.sampleRate)
  } catch (err) {
    parentPort.post({ type: 'error', streamId: msg.streamId, error: String(err) })
  }
}

function attachAudioPort(streamId: string, port: MessagePortMain | undefined): void {
  if (!port) {
    return
  }
  const input: AudioPortInput = { port, onEnded: null }
  // The renderer closes its end after 'end'; a close alone means it went away.
  const end = (): void => {
    if (audioPorts.get(streamId) !== input) {
      return
    }
    audioPorts.delete(streamId)
    port.close()
    input.onEnded?.()
  }
  port.on('message', ({ data }) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the desktop preload holds the other end, and it sends SpeechAudioPortMessage.
    const msg = data as SpeechAudioPortMessage
    enqueue(() =>
      msg.type === 'end'
        ? end()
        : handleFeed({ type: 'feed', streamId, samples: msg.samples, sampleRate: msg.sampleRate })
    )
  })
  port.on('close', end)
  audioPorts.set(streamId, input)
  port.start()
}

async function handleStop(streamId: string): Promise<void> {
  const input = audioPorts.get(streamId)
  // Main's stop can overtake the renderer's last frames on the port; finish only after them.
  if (input) {
    input.onEnded = () => enqueue(() => handleStop(streamId))
    return
  }
  try {
    await recognizer?.finish(streamId)
  } catch (err) {
    parentPort.post({ type: 'error', streamId, error: String(err) })
  } finally {
    parentPort.post({ type: 'stopped', streamId })
  }
}

// A canceled dictation drops its audio undecoded.
function handleDiscard(streamId: string): void {
  const input = audioPorts.get(streamId)
  audioPorts.delete(streamId)
  input?.port.close()
  recognizer?.discard(streamId)
  parentPort.post({ type: 'stopped', streamId })
}

function handleMessage(
  msg: SttWorkerRequest,
  ports: readonly MessagePortMain[]
): void | Promise<void> {
  switch (msg.type) {
    case 'init':
      return handleInit(msg)
    case 'feed':
      return handleFeed(msg)
    case 'stop':
      return handleStop(msg.streamId)
    case 'discard':
      return handleDiscard(msg.streamId)
    case 'attach-audio':
      return attachAudioPort(msg.streamId, ports[0])
  }
}

parentPort.onMessage((message, ports) => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the session host posts here, and it sends SttWorkerRequest.
  const msg = message as SttWorkerRequest
  enqueue(() => handleMessage(msg, ports))
})
