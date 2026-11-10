import type { MessagePortMain } from 'electron'
import type { SpeechAudioPortMessage } from '../../shared/speech-types'
import type { SttRecognizer, SttRecognizerInit, SttRecognizerPost } from './stt-recognizer'
import { createTranscribeCppRecognizer } from './stt-transcribe-cpp-recognizer'
import { connectSttWorkerParentPort } from './stt-worker-parent-port'
import type { SttWorkerRequest } from './stt-worker-process'

// A desktop renderer's audio for one stream, posted straight here instead of through main.
type AudioPortInput = {
  port: MessagePortMain
  onEnded: (() => void) | null
  /** 'end' arrived; its frames may still wait behind a decode. */
  ending: boolean
}

const parentPort = connectSttWorkerParentPort()
let recognizer: SttRecognizer | null = null
const audioPorts = new Map<string, AudioPortInput>()
// Canceled streams whose queued work is skipped instead of decoded; cleared when their discard runs.
const discarded = new Set<string>()

// transcribe-cpp decodes off the event loop; one queue keeps feeds behind init and stop behind feeds.
let queue: Promise<void> = Promise.resolve()
function enqueue(task: () => void | Promise<void>): void {
  // A task that throws must not stop every later one; the session's timeouts report the stream.
  queue = queue.then(task).catch((err: unknown) => {
    console.error('[speech-worker] task failed:', err)
  })
}

async function handleInit(init: SttRecognizerInit): Promise<void> {
  try {
    const post: SttRecognizerPost = (event) => parentPort.post(event)
    recognizer = await createTranscribeCppRecognizer(init, post)
    parentPort.post({ type: 'ready' })
  } catch (err) {
    parentPort.post({ type: 'error', error: String(err) })
  }
}

async function handleFeed(msg: Extract<SttWorkerRequest, { type: 'feed' }>): Promise<void> {
  if (discarded.has(msg.streamId)) {
    return
  }
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
  // A cancel that arrived while this attach waited in line must not let the port's frames reopen the stream.
  if (discarded.has(streamId)) {
    port.close()
    return
  }
  const input: AudioPortInput = { port, onEnded: null, ending: false }
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
    input.ending ||= msg.type === 'end'
    enqueue(() => {
      // A discard or end ran first; a late frame must not reopen the stream.
      if (audioPorts.get(streamId) !== input) {
        return
      }
      return msg.type === 'end'
        ? end()
        : handleFeed({ type: 'feed', streamId, samples: msg.samples, sampleRate: msg.sampleRate })
    })
  })
  // The renderer closes its end right after 'end', so that close must leave the queued frames to decode.
  // A close alone means it canceled or went away.
  port.on('close', () => {
    if (!input.ending) {
      end()
    }
  })
  audioPorts.set(streamId, input)
  port.start()
}

async function handleStop(streamId: string): Promise<void> {
  if (discarded.has(streamId)) {
    return
  }
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

// A cancel answers at once, even during Finish, and the stream's queued audio is skipped rather than decoded.
function cancelStream(streamId: string): void {
  discarded.add(streamId)
  recognizer?.cancel(streamId)
  const input = audioPorts.get(streamId)
  audioPorts.delete(streamId)
  input?.port.close()
  parentPort.post({ type: 'stopped', streamId })
}

// Runs in queue order, after everything queued for the stream before the cancel; the host waits for it.
function handleDiscard(streamId: string): void {
  discarded.delete(streamId)
  recognizer?.discard(streamId)
  parentPort.post({ type: 'discarded', streamId })
}

function handleMessage(
  msg: SttWorkerRequest,
  ports: readonly MessagePortMain[]
): void | Promise<void> {
  switch (msg.type) {
    case 'init':
      return handleInit(msg)
    case 'open':
      return recognizer?.open(msg.streamId, msg.vocabulary)
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
  if (msg.type === 'discard') {
    cancelStream(msg.streamId)
  }
  enqueue(() => handleMessage(msg, ports))
})
