import { encodeBrowserExtensionWireJson } from '../../../../shared/browser/extensions/browser-extension-worker-api'

const MAX_QUEUED_BYTES = 64 * 1024 * 1024

type ContentEvents = {
  body: ReadableStream<Uint8Array>
  send: (value: Uint8Array) => void
  revoke: () => void
  retire: () => void
}

/** A slow document cannot hold storage writers or accumulate unlimited change history. */
export function createBrowserExtensionContentEvents(
  allowed: () => boolean,
  onClose: () => void,
  onOverflow: () => void
): ContentEvents {
  let controller: ReadableStreamDefaultController<Uint8Array>
  let queued: (Uint8Array | undefined)[] = []
  let head = 0
  let bytes = 0
  let pulling = false
  let closed = false
  let terminal: 'overflow' | 'retired' | undefined
  const discard = (): void => {
    queued = []
    head = 0
    bytes = 0
  }
  const finish = (): void => {
    if (!closed) {
      closed = true
      discard()
      onClose()
    }
  }
  const pump = (): void => {
    if (closed || !pulling) {
      return
    }
    if (queued[head] && !allowed()) {
      discard()
    }
    const value = queued[head]
    if (value) {
      queued[head++] = undefined
      bytes -= value.byteLength
      if (head >= 1024 && head * 2 >= queued.length) {
        queued = queued.slice(head)
        head = 0
      }
      pulling = false
      controller.enqueue(value)
    } else if (terminal) {
      pulling = false
      controller.enqueue(
        new TextEncoder().encode(`${encodeBrowserExtensionWireJson({ control: terminal })}\n`)
      )
      controller.close()
      finish()
    }
  }
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value
      },
      pull() {
        pulling = true
        pump()
      },
      cancel: finish
    },
    { highWaterMark: 0 }
  )
  return {
    body,
    send(value) {
      if (closed || terminal) {
        return
      }
      if (bytes + value.byteLength > MAX_QUEUED_BYTES) {
        terminal = 'overflow'
        onOverflow()
      } else {
        queued.push(value)
        bytes += value.byteLength
      }
      pump()
    },
    revoke() {
      discard()
      pump()
    },
    retire() {
      if (!closed) {
        discard()
        terminal = 'retired'
        controller.enqueue(
          new TextEncoder().encode(`${encodeBrowserExtensionWireJson({ control: terminal })}\n`)
        )
        controller.close()
        finish()
      }
    }
  }
}
