# Agent Registry Lifecycle Integration Guide (P0-1)

## Overview

This document describes how to integrate agent session lifecycle events with the Agent Registry (P0-1) for full cross-session coordination support.

## Current State (P0-1)

In P0-1, the Agent Registry provides:
- **Core Data Structure**: In-memory Map of active agent sessions with TTL-based expiration
- **RPC Methods**: Four methods for registration, listing, heartbeat, and unregistration
- **Global Singleton**: A global `getGlobalAgentRegistry()` that agents can access

However, **lifecycle hooks are not yet automatically integrated**. Agents currently need to explicitly call the registry methods. This document outlines how to complete the integration.

## Integration Points

### 1. Agent Startup / Session Creation

**Current Status**: Manual integration required

**Location**: `src/main/runtime/rpc/methods/agent-session.ts` methods:
- `terminal.ensureAgentSession` (line ~285)
- `terminal.createAgentSession` (line ~305)

**What to do**:
```typescript
// After successful session creation, call agent.registry.register via RPC
const registerResult = await runtimeRpc.call('agent.registry.register', {
  keyId: sessionId, // or derived from coordination key
  agentType: params.agent, // e.g., 'pi', 'prime-agent'
  sessionId: terminal.id,
  supportedMethods: [
    // List of capabilities this agent supports
    'file.read',
    'file.write',
    'terminal.ensureAgentSession'
  ],
  metadata: {
    worktreeId: workspace.id,
    connectionId: workspace.connectionId // if remote
  }
})
```

**Challenge**: The `RuntimeTerminalCreate` result doesn't currently expose the `agentSessionClaim` with the coordination key. This needs to be passed through from `orca-runtime.ts` to make auto-registration straightforward.

### 2. Periodic Heartbeat

**Location**: Should be added to agent session lifecycle

**What to do**:
Periodically (e.g., every 30 seconds) call:
```typescript
await runtimeRpc.call('agent.registry.heartbeat', {
  keyId: sessionId
})
```

This keeps the agent alive in the registry and resets its TTL expiration timer.

**Recommendation**: Use a timer in the terminal or session object that fires every 30 seconds, or integrate with existing agent session health checks.

### 3. Agent Shutdown / Session Termination

**Location**: `src/main/runtime/orca-runtime.ts` terminal destruction paths

**Current Challenge**: Multiple termination paths exist:
- Normal exit (user closes terminal)
- Crash/disconnect
- SSH session disconnect
- Renderer disconnection

**Current Coverage**: P0-1 only covers the "happy path" — normal creation and closure.

**What to do for P0-1+**:
Add unregister call in the terminal cleanup handler:
```typescript
// In terminal.close() or similar:
await runtimeRpc.call('agent.registry.unregister', {
  keyId: sessionId
})
```

**Edge Cases NOT Yet Covered** (defer to P0-2+):
- SSH disconnection → should unregister or set stale TTL
- Process crash → TTL cleanup handles this automatically (60 seconds)
- Abnormal termination → same as crash

## Alternative Approach: Agent Self-Registration

Instead of the host managing registration, agents could self-register on startup:
1. Agent process starts and sends `agent.registry.register` to host
2. Host responds with current registry status
3. Agent sends heartbeats periodically
4. Agent sends `unregister` before shutdown

This is more aligned with the intended cross-session design, where agents are first-class distributed components.

## Testing the Integration

After implementing lifecycle hooks, verify:
```bash
# List all agents after creating a new session
npm run test -- src/main/runtime/rpc/methods/agent-registry.test.ts

# Check specific agents
curl http://localhost:5000/api/rpc \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"method": "agent.registry.list", "params": {"agentType": "pi"}}'
```

## Future Work (P0-2+)

Once lifecycle integration is complete:
1. Implement message broker (P0-2) to route requests between agents
2. Add permission gateway (P1-1) for capability validation
3. Implement session-aware UI for agent discovery (P1-2)
4. Full agent session management with resilience (P2-1)

## Files Modified/Created for P0-1

- `src/shared/agent-registry.ts` — Type definitions
- `src/main/runtime/agent-registry.ts` — Core registry implementation
- `src/main/runtime/rpc/methods/agent-registry.ts` — RPC method implementations
- `src/main/runtime/rpc/methods/index.ts` — Registration of RPC methods

## Key Design Decisions

1. **60-second TTL**: Chosen to give agents time to send heartbeats without being too lenient
2. **Lazy cleanup in list()**: More efficient than periodic background scanning for small numbers of agents
3. **No persistence**: Registry is in-memory only, lost on restart (ok for P0-1)
4. **Capability digest**: For integrity checking; can be extended to verify capability claims in P0-2+
