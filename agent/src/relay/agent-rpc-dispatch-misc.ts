// src/relay/agent-rpc-dispatch-misc.ts
// tools/list, tools/call, preflight.*, host.capabilities, shell.eval,
// shell.exec, notification.send, and connection.teardown RPC methods —
// split out of agent-rpc-dispatch.ts's giant switch to keep each file under
// the oxlint max-lines budget. cli.*/accounts.*/vm.* live in their own
// dispatch-cli.ts/-accounts.ts/-vm.ts siblings for the same reason.

import type WebSocket from 'ws'
import type { WireState } from 'orca-dev-agent-transport'
import type { ToolDefinition, ToolResult } from './agent-tool-registry'
import type { AgentConfig } from './agent-config'
import type { AgentLogger } from './agent-logger'
import { AgentErrorCode } from '../shared/agent-wire-protocol'
import type { JsonRpcRequest, JsonRpcResponse } from './agent-rpc-dispatch'
import { makeError, formatMcpResult } from './agent-rpc-dispatch'

export async function dispatchMiscRpc(
  rpc: JsonRpcRequest,
  tools: ToolDefinition[],
  config: AgentConfig,
  log: AgentLogger,
  ws: WebSocket,
  // Why unused: vm.provision (the one case here that needed WireState for
  // its stream.chunk/stream.end frames) moved to agent-rpc-dispatch-vm.ts
  // (max-lines split). Kept in the signature for shape-consistency with
  // every other dispatchXxxRpc function route() calls positionally
  // (dispatchFsRpc/dispatchBrowserRpc etc. all take the same param set).
  _state: WireState
): Promise<JsonRpcResponse | null> {
  switch (rpc.method) {
    // ── MCP: tools/list ──────────────────────────────────────────────────────
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema
          }))
        }
      }

    // ── MCP: tools/call ──────────────────────────────────────────────────────
    case 'tools/call': {
      const params = rpc.params ?? {}
      const name = typeof params.name === 'string' ? params.name : ''
      const args =
        typeof params.arguments === 'object' && params.arguments !== null
          ? (params.arguments as Record<string, unknown>)
          : {}

      const tool = tools.find((t) => t.name === name)
      if (!tool) {
        return makeError(rpc.id, AgentErrorCode.MethodNotFound, `Tool not found: ${name}`)
      }

      log.info(`tools/call name=${name} args=${JSON.stringify(args).slice(0, 120)}`)

      let result: ToolResult
      try {
        result = await tool.handler(args, config)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        log.error(`tools/call handler threw name=${name}: ${msg}`)
        return makeError(rpc.id, AgentErrorCode.ServerError, `Tool handler error: ${msg}`)
      }

      return formatMcpResult(rpc.id, result)
    }

    // ── v5.0: preflight.check ────────────────────────────────────────────────
    case 'preflight.check': {
      try {
        const { handlePreflightCheck } = await import('./fs-agent-extensions')
        return (await handlePreflightCheck(rpc.id, rpc.params ?? {}, config)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `preflight.check unavailable: ${msg}`)
      }
    }

    // ── preflight.detectAgents ───────────────────────────────────────────────
    // Called by dev-server-relay-bridge.ts's detectAgents() (onboarding-ipc.ts).
    // Previously Part-B-only; see specs/agent/api/gaps-and-findings.md #5.
    case 'preflight.detectAgents': {
      try {
        const { handleDetectAgents } = await import('./agent-preflight-handler')
        return (await handleDetectAgents(rpc.id, rpc.params ?? {})) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `preflight.detectAgents unavailable: ${msg}`
        )
      }
    }

    // ── preflight.detectWindowsTerminalCapabilities ──────────────────────────
    case 'preflight.detectWindowsTerminalCapabilities': {
      try {
        const { handleDetectWindowsTerminalCapabilities } =
          await import('./agent-preflight-handler')
        return (await handleDetectWindowsTerminalCapabilities(rpc.id)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `preflight.detectWindowsTerminalCapabilities unavailable: ${msg}`
        )
      }
    }

    // ── preflight.detectGhosttyConfig ────────────────────────────────────────
    case 'preflight.detectGhosttyConfig': {
      try {
        const { handleDetectGhosttyConfig } = await import('./agent-preflight-handler')
        return (await handleDetectGhosttyConfig(rpc.id)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `preflight.detectGhosttyConfig unavailable: ${msg}`
        )
      }
    }

    // ── preflight.setGitIdentity ─────────────────────────────────────────────
    // BUG-AG-HLD-003 parity for Part A — stores identity per-connection
    // (git-identity-registry.ts), consumed by git.exec's `commit` subcommand.
    case 'preflight.setGitIdentity': {
      try {
        const { handleSetGitIdentity } = await import('./agent-preflight-handler')
        return (await handleSetGitIdentity(rpc.id, rpc.params ?? {}, ws)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `preflight.setGitIdentity unavailable: ${msg}`
        )
      }
    }

    // ── host.capabilities ────────────────────────────────────────────────────
    // TASK-070: relayed by infra-fleet-service's GetHostCapabilities usecase.
    // See get_host_capabilities.go's doc comment for the full gap this closes.
    case 'host.capabilities': {
      try {
        const { handleHostCapabilities } = await import('./agent-preflight-handler')
        return (await handleHostCapabilities(rpc.id)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `host.capabilities unavailable: ${msg}`
        )
      }
    }

    // cli.* moved to agent-rpc-dispatch-cli.ts (max-lines split).
    // vm.exec / vm.provision / vm.cancelProvision moved to
    // agent-rpc-dispatch-vm.ts (max-lines split). See route() in
    // agent-rpc-dispatch.ts, which tries both dispatchers before this file.

    // Runs a short shell command and returns stdout/stderr.
    // Used by devServer.browseDir on the Orca server to resolve '~' on the remote.
    // SECURITY: only used internally via relay — not exposed to browser directly.
    case 'shell.eval': {
      try {
        const { handleShellEval } = await import('./fs-agent-extensions')
        return (await handleShellEval(rpc.id, rpc.params ?? {}, config)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `shell.eval unavailable: ${msg}`)
      }
    }

    // ── shell.exec ───────────────────────────────────────────────────────────
    // Workflow 'shell' step executor. Called by:
    //   StepExecutors.executeShell() via relay.call('shell.exec', { script, env, traceId })
    // Previously unimplemented (specs/agent/api/gaps-and-findings.md #1).
    case 'shell.exec': {
      try {
        const { handleShellExec } = await import('./fs-agent-extensions')
        return (await handleShellExec(rpc.id, rpc.params ?? {}, config)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `shell.exec unavailable: ${msg}`)
      }
    }

    // ── notification.send ────────────────────────────────────────────────────
    // Workflow 'notification' step executor. Called by:
    //   StepExecutors.executeNotification() via
    //   relay.call('notification.send', { channel, message, traceId })
    // Previously unimplemented (specs/agent/api/gaps-and-findings.md #1).
    case 'notification.send': {
      try {
        const { handleNotificationSend } = await import('./notification-send-handler')
        return (await handleNotificationSend(rpc.id, rpc.params ?? {}, log)) as JsonRpcResponse
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(
          rpc.id,
          AgentErrorCode.ServerError,
          `notification.send unavailable: ${msg}`
        )
      }
    }

    // accounts.* moved to agent-rpc-dispatch-accounts.ts (max-lines split).

    // ── connection.teardown ──────────────────────────────────────────────────
    // CR-STORAGE-008(a) / TASK-AG-STORAGE-007: infra-fleet-service's
    // TeardownConnection usecase (confirmed-logout path,
    // backend-go/services/infra-fleet-service/internal/usecase/teardown_connection.go)
    // calls this over the same live agent.Exec transport every other
    // request/response method uses — no new wire protocol. Unlike an
    // ordinary WS disconnect (which now arms a grace period — see
    // agent-session.ts's stop(), CR-STORAGE-008(b)), a confirmed teardown
    // kills every PTY immediately: both agent.spawn PTYs (cleanupAllPtys,
    // already the immediate-kill path — see its own doc comment on why it
    // no longer runs on every disconnect) and terminal (pty.create) PTYs,
    // via the detached daemon's daemon.sessionTeardown (bypasses its own
    // grace period too — see pty-daemon-server.ts).
    case 'connection.teardown': {
      try {
        const { cleanupAllPtys } = await import('./agent-spawner')
        const { notifyDaemonSessionTeardown } = await import('./pty-daemon-client')
        cleanupAllPtys(log)
        await notifyDaemonSessionTeardown(log)
        return { jsonrpc: '2.0', id: rpc.id, result: { ok: true } }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return makeError(rpc.id, AgentErrorCode.ServerError, `connection.teardown failed: ${msg}`)
      }
    }

    default:
      return null
  }
}
