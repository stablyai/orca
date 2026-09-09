import { createConnection } from 'node:net'
import { DispatcherClientWriter } from './dispatcher-client-writer'
import { pickRemoteCliEnv } from './remote-cli-env'
import { shouldReadRemoteCliStdin } from './remote-cli-stdin'
import { prepareRemoteArtifactCliInput } from './remote-artifact-cli-input'
import {
  assertRemoteArtifactCliForwardingFits,
  type RemoteArtifactCliForwardingParams
} from './remote-artifact-cli-forwarding'
import {
  FrameDecoder,
  MessageType,
  encodeJsonRpcFrame,
  parseJsonRpcMessage,
  type DecodedFrame,
  type JsonRpcResponse
} from './protocol'
import { readLaunchVersion, runConnectHandshake } from './relay-handshake'

const CONNECT_TIMEOUT_MS = 5_000

export async function runRelayOrcaCliChannel(
  sockPath: string,
  argv: string[],
  endpointCredential?: string
): Promise<void> {
  const myVersion = readLaunchVersion()
  let preparedArtifact: Awaited<ReturnType<typeof prepareRemoteArtifactCliInput>>
  try {
    preparedArtifact = await prepareRemoteArtifactCliInput(argv, process.cwd())
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
    return
  }
  const stdin =
    preparedArtifact.stdin ??
    (shouldReadRemoteCliStdin(argv) ? await readOrcaCliStdin() : undefined)
  const env = pickRemoteCliEnv(process.env)
  const requestParams: RemoteArtifactCliForwardingParams = {
    argv,
    cwd: process.cwd(),
    env,
    ...(stdin !== undefined ? { stdin } : {}),
    ...(preparedArtifact.artifactInput ? { artifactInput: preparedArtifact.artifactInput } : {})
  }
  if (preparedArtifact.artifactInput) {
    try {
      assertRemoteArtifactCliForwardingFits(requestParams)
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
      return
    }
  }
  const sock = createConnection({ path: sockPath })
  const stdoutWriter = new DispatcherClientWriter(
    (data, onSettled) =>
      process.stdout.write(data, (error) => {
        onSettled(error ? { ok: false, error } : { ok: true })
      }),
    {
      supportsWriteCallback: true,
      writableLength: () => process.stdout.writableLength,
      writableHighWaterMark: () => process.stdout.writableHighWaterMark,
      waitWriteDrain: (callback) => {
        process.stdout.once('drain', callback)
        return () => process.stdout.off('drain', callback)
      }
    },
    () => process.exit(1)
  )
  let nextSeq = 1
  let highestReceivedSeq = 0
  const requestId = 1
  const postOutputRequestId = 2
  let initialExitCode = 0

  const sendRequest = (): void => {
    const frame = encodeJsonRpcFrame(
      {
        jsonrpc: '2.0',
        id: requestId,
        method: 'orca.cli',
        params: requestParams
      },
      nextSeq++,
      highestReceivedSeq
    )
    sock.write(frame)
  }

  const finish = (exitCode: number): void => {
    sock.destroy()
    process.exit(exitCode)
  }

  const sendPostOutput = (postOutput: unknown): void => {
    sock.write(
      encodeJsonRpcFrame(
        {
          jsonrpc: '2.0',
          id: postOutputRequestId,
          method: 'orca.cli.postOutput',
          params: { postOutput, env: pickRemoteCliEnv(process.env) }
        },
        nextSeq++,
        highestReceivedSeq
      )
    )
  }

  const writeOutput = (
    result: { stdout?: unknown; stderr?: unknown },
    onFlushed: (error?: Error) => void
  ): void => {
    let pending = 0
    let completed = false
    const settle = (error?: Error): void => {
      if (completed) {
        return
      }
      if (error) {
        completed = true
        onFlushed(error)
        return
      }
      pending -= 1
      if (pending === 0) {
        completed = true
        onFlushed()
      }
    }
    if (typeof result.stdout === 'string' && result.stdout.length > 0) {
      pending += 1
      const output = Buffer.from(result.stdout)
      stdoutWriter.enqueue(
        'control',
        () => output,
        output.length,
        (settlement) => settle(settlement.ok ? undefined : settlement.error)
      )
    }
    if (typeof result.stderr === 'string' && result.stderr.length > 0) {
      pending += 1
      process.stderr.write(result.stderr, 'utf8', (error) => settle(error ?? undefined))
    }
    if (pending === 0) {
      completed = true
      onFlushed()
    }
  }

  const decoder = new FrameDecoder((frame: DecodedFrame) => {
    if (frame.id > highestReceivedSeq) {
      highestReceivedSeq = frame.id
    }
    if (frame.type !== MessageType.Regular) {
      return
    }
    const msg = parseJsonRpcMessage(frame.payload)
    if (
      !('id' in msg) ||
      (msg.id !== requestId && msg.id !== postOutputRequestId) ||
      !('result' in msg || 'error' in msg)
    ) {
      return
    }
    const response = msg as JsonRpcResponse
    if (response.error) {
      process.stderr.write(`${response.error.message}\n`)
      finish(1)
      return
    }
    if (response.id === postOutputRequestId) {
      finish(initialExitCode)
      return
    }
    const result = (response.result ?? {}) as {
      stdout?: unknown
      stderr?: unknown
      exitCode?: unknown
      postOutput?: unknown
    }
    initialExitCode = typeof result.exitCode === 'number' ? result.exitCode : 0
    writeOutput(result, (error) => {
      if (error) {
        finish(1)
        return
      }
      if (result.postOutput === undefined) {
        finish(initialExitCode)
        return
      }
      sendPostOutput(result.postOutput)
    })
  })

  const connectTimeout = setTimeout(() => {
    process.stderr.write(`[orca-cli] Relay connection timed out after ${CONNECT_TIMEOUT_MS}ms\n`)
    sock.destroy()
    process.exit(1)
  }, CONNECT_TIMEOUT_MS)

  sock.on('connect', () => {
    clearTimeout(connectTimeout)
    runConnectHandshake(
      sock,
      myVersion,
      {
        onAccepted: (leftover) => {
          if (leftover.length > 0) {
            decoder.feed(leftover)
          }
          sock.on('data', (chunk) =>
            decoder.feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          )
          sendRequest()
        }
      },
      endpointCredential
    )
  })

  sock.on('error', (error) => {
    clearTimeout(connectTimeout)
    process.stderr.write(`[orca-cli] Relay socket error: ${error.message}\n`)
    process.exit(1)
  })
}

async function readOrcaCliStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    return undefined
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}
