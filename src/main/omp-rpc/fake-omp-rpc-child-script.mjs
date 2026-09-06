#!/usr/bin/env node

import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const scenario = JSON.parse(process.argv.at(-1) ?? '{}')
let sessionState = scenario.sessionState ?? {
  sessionFile: null,
  sessionId: null,
  isStreaming: false,
  isCompacting: false,
  queuedMessageCount: 0
}
const readyFrame = {
  type: 'ready',
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1_048_576,
  maxReassembledFrameBytes: 67_108_864,
  ...scenario.readyFrameOverrides
}

if (scenario.sigtermMarkerPath) {
  process.on('SIGTERM', () => {
    appendFileSync(scenario.sigtermMarkerPath, 'SIGTERM')
    process.exit(0)
  })
}

if (scenario.argvMarkerPath) {
  appendFileSync(scenario.argvMarkerPath, JSON.stringify(process.argv.slice(2, -1)))
}

function writeLine(frame) {
  const line = typeof frame === 'string' ? frame : JSON.stringify(frame)
  process.stdout.write(`${line}\n`)
}

function writeChunkedCommandOutput(textLength, fault) {
  const bytes = Buffer.from(
    JSON.stringify({ type: 'command_output', text: 'x'.repeat(textLength) })
  )
  const payloads = []
  for (let offset = 0; offset < bytes.length; offset += 262_144) {
    payloads.push(bytes.subarray(offset, offset + 262_144))
  }
  for (const [index, payload] of payloads.entries()) {
    if (fault === 'interleaved-frame' && index === 1) {
      writeLine({ type: 'command_output', text: 'interleaved' })
    }
    writeLine({
      type: 'rpc_chunk',
      chunkId: fault === 'chunk-id-mismatch' && index === 1 ? 'fake-chunk-2' : 'fake-chunk-1',
      index: fault === 'wrong-start-index' && index === 0 ? 1 : index,
      count: payloads.length,
      byteLength: fault === 'byte-length-mismatch' ? bytes.length + 1 : bytes.length,
      data: payload.toString('base64')
    })
  }
}

writeLine(scenario.firstFrame ?? readyFrame)

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const command = JSON.parse(line)
  if (scenario.exitOnCommand === command.type) {
    const exit = () => process.exit(scenario.exitCode ?? 17)
    if (scenario.stderrBeforeExit) {
      process.stderr.write(scenario.stderrBeforeExit, exit)
    } else {
      exit()
    }
    return
  }
  if (scenario.commandMarkerPath) {
    appendFileSync(scenario.commandMarkerPath, `${JSON.stringify(command)}\n`)
  }
  // A child that is alive and reading stdin but never answers this command —
  // the only shape that proves the client's own response deadline (XLR-016).
  if (scenario.swallowCommands?.includes(command.type)) {
    return
  }
  const commandError = scenario.commandErrors?.[command.type]
  if (commandError) {
    writeLine({
      id: command.id,
      type: 'response',
      command: command.type,
      success: false,
      error: commandError.error,
      code: commandError.code
    })
    return
  }
  if (command.type === 'get_available_commands') {
    writeLine({
      id: command.id,
      type: 'response',
      command: 'get_available_commands',
      success: true,
      data: { commands: scenario.commands ?? [] }
    })
    return
  }
  if (command.type === 'set_subagent_subscription') {
    writeLine({
      id: command.id,
      type: 'response',
      command: 'set_subagent_subscription',
      success: true,
      data: { level: command.level }
    })
    return
  }
  if (command.type === 'get_state') {
    const response = {
      id: command.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: sessionState
    }
    // ONE write, so the trailing garbage lands in the SAME stdout chunk as the
    // response it follows: the client then resolves the pending command and
    // faults before the awaiting caller's continuation runs (XLR-R6-001).
    const trailer =
      scenario.malformedAfterGetState === undefined ? '' : `${scenario.malformedAfterGetState}\n`
    process.stdout.write(`${JSON.stringify(response)}\n${trailer}`)
    return
  }
  if (command.type === 'get_messages_page') {
    if (scenario.historyPageMarkerPath) {
      appendFileSync(scenario.historyPageMarkerPath, `${JSON.stringify(command)}\n`)
    }
    let data = scenario.historyMalformedPage
    if (data === undefined) {
      const all = scenario.historyMessages ?? []
      const offset = command.cursor === undefined ? 0 : Number(command.cursor)
      const page = all.slice(offset, offset + (command.limit ?? 100))
      const nextOffset = offset + page.length
      data = {
        messages: page,
        ...(nextOffset < all.length ? { nextCursor: String(nextOffset) } : {}),
        totalMessages: all.length
      }
    }
    writeLine({
      id: command.id,
      type: 'response',
      command: 'get_messages_page',
      success: true,
      data
    })
    return
  }
  if (command.type === 'abort') {
    sessionState = {
      ...sessionState,
      isStreaming: false,
      isCompacting: false,
      queuedMessageCount: 0
    }
    writeLine({
      id: command.id,
      type: 'response',
      command: 'abort',
      success: true
    })
    return
  }
  if (command.type === 'switch_session') {
    sessionState = { ...sessionState, sessionFile: command.sessionPath }
    writeLine({
      id: command.id,
      type: 'response',
      command: 'switch_session',
      success: true
    })
    return
  }
  if (command.type === 'extension_ui_response') {
    if (scenario.extensionUiResponseMarkerPath) {
      appendFileSync(scenario.extensionUiResponseMarkerPath, `${JSON.stringify(command)}\n`)
    }
    return
  }
  if (command.type === 'prompt' || command.type === 'steer' || command.type === 'follow_up') {
    const agentInvoked =
      command.type === 'prompt'
        ? scenario.promptAgentInvoked
        : command.type === 'steer'
          ? scenario.steerAgentInvoked
          : scenario.followUpAgentInvoked
    if (command.type === 'prompt' && scenario.promptImmediateAcknowledgement) {
      writeLine({
        id: command.id,
        type: 'response',
        command: command.type,
        success: true,
        ...(typeof agentInvoked === 'boolean' ? { data: { agentInvoked } } : {})
      })
    }
    for (const text of scenario.promptOutput ?? []) {
      writeLine({ type: 'command_output', text })
    }
    const events =
      command.type === 'prompt'
        ? (scenario.promptEvents ?? [])
        : command.type === 'steer'
          ? (scenario.steerEvents ?? [])
          : (scenario.followUpEvents ?? [])
    for (const frame of events) {
      writeLine(frame)
    }
    if (
      command.type === 'prompt' &&
      scenario.promptResultAgentInvoked === undefined &&
      scenario.promptAsyncError === undefined &&
      events.every((frame) => frame?.type !== 'agent_end')
    ) {
      writeLine({ type: 'agent_end' })
    }
    if (command.type === 'prompt' && typeof scenario.promptResultAgentInvoked === 'boolean') {
      writeLine({
        type: 'prompt_result',
        id: command.id,
        agentInvoked: scenario.promptResultAgentInvoked
      })
    }
    // An extension/builtin slash command whose handler creates, branches, or
    // switches the session: upstream announces none of it, so the only trace is
    // a changed `get_state` (XLR-018).
    if (command.type === 'prompt' && scenario.promptSessionChange) {
      sessionState = { ...sessionState, ...scenario.promptSessionChange }
    }
    if (command.type === 'prompt' && scenario.promptAsyncError) {
      writeLine({
        id: command.id,
        type: 'response',
        command: command.type,
        success: false,
        error: scenario.promptAsyncError.error,
        code: scenario.promptAsyncError.code
      })
      return
    }
    if (command.type === 'prompt' && scenario.promptImmediateAcknowledgement) {
      return
    }
    writeLine({
      id: command.id,
      type: 'response',
      command: command.type,
      success: true,
      ...(typeof agentInvoked === 'boolean' ? { data: { agentInvoked } } : {})
    })
    return
  }
  if (command.type !== 'negotiate_protocol') {
    return
  }
  writeLine(
    scenario.negotiationResponse ?? {
      id: command.id,
      type: 'response',
      command: 'negotiate_protocol',
      success: true,
      data: { protocolVersion: 2 }
    }
  )
  for (const frame of scenario.afterNegotiationFrames ?? []) {
    writeLine(frame)
  }
  if (scenario.malformedAfterNegotiationLine) {
    writeLine(scenario.malformedAfterNegotiationLine)
  }
  if (typeof scenario.chunkedCommandOutputLength === 'number') {
    writeChunkedCommandOutput(scenario.chunkedCommandOutputLength, scenario.chunkFault)
  }
})
