// Fence raw sendRequest access/selectors, sendSingleFlightRequest calls and raw-port imports per file.
// Counts are ceilings that only shrink; the boundary test rejects new, missing or increased entries.
// Owners implement or route the port; migrate pending callers only after recording their existing behavior.
export type UnvalidatedRpcRequestPortEntry = {
  readonly file: string
  readonly references: number
}

/** Modules whose job is the port. These do not shrink to zero. */
export const UNVALIDATED_RPC_REQUEST_PORT_OWNERS: readonly UnvalidatedRpcRequestPortEntry[] = [
  // Forward raw page requests without choosing a method or decoding replies.
  { file: 'src/mobile-web-shell/bridge-host-requests.ts', references: 3 },
  // Expose the port to the page without interpreting its requests or replies.
  { file: 'src/mobile-web-shell/bridge/bridge-rpc-client.ts', references: 1 },
  // Fakes the port for the bridge host suites; a non-test file only because tsconfig excludes tests.
  { file: 'src/mobile-web-shell/bridge-host-test-fakes.ts', references: 1 },
  // Implements the port over the device-to-host websocket.
  { file: 'src/transport/direct-rpc-client.ts', references: 3 },
  // Fakes the port for the supervisor suites; a non-test file only because tsconfig excludes tests.
  { file: 'src/transport/mobile-endpoint-supervisor-test-fakes.ts', references: 2 },
  // Implements the port over a relay channel.
  { file: 'src/transport/mobile-relay-physical-client.ts', references: 2 },
  // Supplies the port for one relay session.
  { file: 'src/transport/mobile-relay-rpc-session.ts', references: 1 },
  // A second raw sender: string method in, unread envelope out. Its callers are fenced too.
  { file: 'src/transport/request-single-flight.ts', references: 3 },
  // Owns connect-wait, timeout and replay bookkeeping for every raw request.
  { file: 'src/transport/rpc-client-request-tracker.ts', references: 1 },
  // Composes the port into RpcClient, which is why every holder of a client still carries it.
  { file: 'src/transport/rpc-client.ts', references: 2 },
  // The typed boundary itself — the one module that turns a reply into a declared type.
  { file: 'src/transport/rpc-operation.ts', references: 5 },
  // Forwards the port with the workspace's execution host stamped on; picks no method.
  { file: 'src/transport/execution-host-scoped-rpc-client.ts', references: 2 },
  // Forwards the port across a physical-client cutover.
  { file: 'src/transport/stable-logical-rpc-client.ts', references: 2 },
  // Names the port as the recording oracle's sender contract; a non-test file for the same reason.
  { file: 'src/test-support/rpc-recording/recording-scenario.ts', references: 1 },
  // Record names once per logical call above physical replay and below asynchronous wrappers.
  { file: 'src/test-support/rpc-recording/scripted-rpc-transport.ts', references: 7 }
]

/** Call sites awaiting migration to a typed operation. Grouped by the feature area that owns them. */
export const UNVALIDATED_RPC_REQUEST_PORT_PENDING: readonly UnvalidatedRpcRequestPortEntry[] = [
  // Accounts recording needs useFocusEffect/ScrollView substitutes and an accounts.subscribe stream scenario.
  { file: 'src/accounts/MobileAccountsScreen.tsx', references: 2 },

  // callAgentSession accepts dynamic methods and generic results; typed operations require restructuring its callers.
  { file: 'src/session/mobile-structured-agent-session-rpc.ts', references: 1 },
  // The recorded create-terminal prompt uses a unique empty-refusal fallback absent from existing terminal.send operations.
  { file: 'src/session/use-mobile-session-terminal-create-actions.ts', references: 1 },

  // Dynamic git action steps must be typed before this dispatcher can use fixed-method operations.
  { file: 'src/source-control/use-mobile-git-requests.ts', references: 1 },

  // Scanner references the literal sendRequest without sending requests.
  { file: 'src/tasks/mobile-tasks-source-family.test-support.ts', references: 1 },

  // Wraps a PairingCandidateClient as its raw port; the one chosen method already uses hostStatusProbe.
  { file: 'src/transport/pairing-relay-candidate.ts', references: 4 },
  // Capability negotiation runs before connected and outside the recorder’s client surface; preserve its shared method/params.
  { file: 'src/transport/mobile-runtime-capability-negotiation.ts', references: 2 },
  // Uses hostStatusProbe but accepts a raw sender because push registration holds no full client.
  { file: 'src/transport/runtime-status-probe.ts', references: 1 }
]
