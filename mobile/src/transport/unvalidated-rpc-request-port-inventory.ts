/**
 * Every file that still reaches mobile's raw RPC request port, held as data.
 *
 * A reference is any direct reach for the port: a `.sendRequest` access or declaration, a
 * `'sendRequest'` selector such as `Pick<RpcClient, 'sendRequest'>`, a call to the coalescing
 * second sender `sendSingleFlightRequest`, or an import of unvalidated-rpc-request-port.ts.
 * The count is per file and is a ceiling, not a target: unvalidated-rpc-request-port-boundary.test.ts
 * fails on a file that is not listed, on a listed file that no longer reaches the port, and on a
 * listed file whose count went up. Both lists only shrink.
 *
 * The owners are permanent — they implement, route or validate the port. The pending list is the
 * step-4 migration backlog and shares one reason, stated once here instead of 144 times:
 * the call site predates the typed contract and still picks its own method string, its own
 * acceptance rule and its own decoding. Replacing one with an RpcOperation deletes its line.
 *
 * Where a group below names a blocker, it is a recording blocker, not a migration blocker.
 * Pointing a site at an operation is mechanical; the golden recorded against the old code before
 * the refactor is the only parity proof this migration has. So a site the recorder cannot mount
 * cannot be recorded, and unrecorded sites do not migrate.
 */
export type UnvalidatedRpcRequestPortEntry = {
  readonly file: string
  readonly references: number
}

/** Modules whose job is the port. These do not shrink to zero. */
export const UNVALIDATED_RPC_REQUEST_PORT_OWNERS: readonly UnvalidatedRpcRequestPortEntry[] = [
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
  // Forwards the port across a physical-client cutover.
  { file: 'src/transport/stable-logical-rpc-client.ts', references: 2 },
  // Names the port as the recording oracle's sender contract; a non-test file for the same reason.
  { file: 'src/test-support/rpc-recording/recording-scenario.ts', references: 1 },
  // Scripts the port for the recording oracle, over the real tracker and logical client.
  { file: 'src/test-support/rpc-recording/scripted-rpc-transport.ts', references: 5 }
]

/** Call sites awaiting migration to a typed operation. Grouped by the feature area that owns them. */
export const UNVALIDATED_RPC_REQUEST_PORT_PENDING: readonly UnvalidatedRpcRequestPortEntry[] = [
  // app/h/[hostId]/ — Expo route screens
  { file: 'app/h/[hostId]/accounts.tsx', references: 2 },

  // app/ — Expo route screens
  { file: 'app/terminal-settings.tsx', references: 3 },

  // src/agent-history/ — agent history loads. The history scan and its resume metadata migrated in
  // step 4; see mobile-agent-history-operations.ts.
  // Holdout: the last reach is a worktree.ps inside the screen component's own effect, which no
  // recording can mount without a fabricated react-native view tree.
  { file: 'src/agent-history/MobileAgentSessionHistoryPanel.tsx', references: 1 },

  // src/components/ — shared widgets that fetch their own data. Nothing is left here: the New
  // Workspace drawer's execution target, setup hook, runtime context and Codex capability probe
  // migrated in step 4, and the last two followed once a scenario could declare the device store
  // both of them read. See new-workspace-operations.ts,
  // codex-reset-credit-{capability,consume}-operations.ts, the SSH and agent-detection operations
  // in tasks/mobile-workspace-source-operations.ts, and the repo.list readers the dialog now shares
  // in session/mobile-session-read-operations.ts.

  // src/files/ — file read, write and preview. The preview loader, the terminal-artifact grant
  // refresh and save, the session file tab and the mutation-ownership capture migrated in step 4:
  // see mobile-file-preview-operations.ts, mobile-file-tab-doc-operations.ts and
  // mobile-file-ownership-operations.ts. The explorer panel's two sends sit inline in a React
  // Native screen, which the recorder cannot mount and so cannot record.
  { file: 'src/files/MobileFileExplorerPanel.tsx', references: 2 },

  // src/home/ — home screen host reads. The stats card and both task-provider probes migrated in
  // step 4 (mobile-home-host-operations.ts, plus the shared task-tooling reads in
  // tasks/mobile-task-runtime-operations.ts). The accounts read stays: its decoder is re-exported
  // through a React Native screen module, which no recording can load.
  { file: 'src/home/mobile-home-host-requests.ts', references: 2 },

  // src/host-screen/ — host screen catalog and actions. The repo and label metadata reads, the
  // desktop view-settings mirror and the list's pin, remove and activate mutations migrated in
  // step 4; see host-screen-operations.ts. What is left sends from inside a React Native screen,
  // which the recorder cannot mount.
  { file: 'src/host-screen/host-screen-overlays.tsx', references: 1 },

  // src/notifications/ — push registration and delivery. Registration and unregistration migrated
  // in step 4; see mobile-push-registration-operations.ts. Tray reconciliation followed once a
  // scenario could declare the notification tray and the stored host list it resolves against;
  // see push-dismissal-operations.ts.
  // Holdout: the unsubscribe is a closure inside a `subscribe` callback, and subscriptions are a
  // later step; the request-only recording runner refuses to open one.
  { file: 'src/notifications/mobile-notifications.ts', references: 1 },

  // src/session/ — session screen: chat, diff review, PR actions, tabs. The github.* PR surface,
  // the diff-review loaders and the rest of the screen migrated in step 4; see
  // mobile-session-{read,write,launch}-operations.ts, mobile-clipboard-image-operations.ts and
  // mobile-diff-review-git-operations.ts. The terminal input surface followed: the composed send,
  // the live keystroke send and the clipboard paste all send through terminal.input-send in
  // terminal/mobile-terminal-operations.ts, and the accessory's connection lookup reads the repo
  // list through the new-tab operation. Every holdout below opens or rides a subscription or takes its
  // method as a parameter, except the gesture-input file, which this PR simply did not cover.
  // Holdout: the method is a parameter. `callAgentSession` takes a method string and a generic
  // result type, and five call sites across two hooks pass their own, plus one inside this module's
  // own mutation wrapper; an operation fixes the method at definition time, so migrating it is a
  // restructure of those callers rather than of this send.
  { file: 'src/session/mobile-structured-agent-session-rpc.ts', references: 1 },
  // Holdout: unrecorded site, record-first rule. `worktree.show` here sits inside the same focus
  // effect as a `runtime.clientEvents` subscription, and the request-only recording runner refuses
  // to open one, so no golden can hold this file's behaviour.
  { file: 'src/session/use-live-worktree-name.ts', references: 1 },
  // Holdout: unrecorded site, record-first rule. The `nativeChat.readSession` read lives in the
  // paging callback, not in an effect, but only the mount effect's `nativeChat.subscribe` arms the
  // offset and generation it pages against — and the request-only runner refuses to open one.
  { file: 'src/session/use-mobile-native-chat-session.ts', references: 1 },
  // Holdout: unrecorded site, record-first rule. The startup effect drives 36 members of the
  // session model including the terminal subscription lifecycle, which is a later step.
  { file: 'src/session/use-mobile-session-startup.ts', references: 2 },
  // Holdout: unrecorded site, record-first rule. The create path subscribes to the terminal it
  // makes, and the request-only runner refuses the subscription.
  { file: 'src/session/use-mobile-session-terminal-create-actions.ts', references: 2 },
  // Holdout: scope only, no recorder gap. The gesture flush reads refs (client, connection state,
  // PTY modes, the gesture buckets, active handle and tab type), and the clear-buffer ref optional-
  // chains the webview, so a mount with a null terminal ref records both sends. These 2 refs are
  // migratable as they stand; they were out of this PR's bucket.
  { file: 'src/session/use-mobile-session-terminal-input.ts', references: 2 },
  // Holdout: unrecorded site, record-first rule. The display-mode write is gated on an open
  // terminal subscription, which is a later step.
  { file: 'src/session/use-mobile-session-terminal-stream-display.ts', references: 1 },

  // src/settings/ — notification display probe
  { file: 'src/settings/notification-display-test.tsx', references: 1 },

  // src/source-control/ — one dynamic dispatcher left; the other 13 files migrated in step 4.
  // Its single reference multiplexes git.commit, git.status, git.upstreamStatus, git.fetch,
  // git.pull, git.push and every `{ method, params }` action step five other hooks hand it, so
  // it cannot drop below one until that step model is typed. See mobile-git-read-operations.ts
  // and mobile-git-mutation-operations.ts for the operations the rest of the domain now sends.
  { file: 'src/source-control/use-mobile-git-requests.ts', references: 1 },

  // src/tasks/ — task lists, filters and mutations. The workspace-creation half migrated in
  // step 4; the provider item, detail, list and GitHub Projects board half followed, taking 70
  // references across 22 files to zero. See mobile-task-item-detail-operations.ts,
  // mobile-task-list-operations.ts, mobile-task-item-comment-operations.ts,
  // mobile-task-item-state-operations.ts and mobile-task-project-board-operations.ts, alongside
  // the workspace-creation modules. Three files cannot reach zero, and none of them for the
  // reason the previous note gave — both `{ method, params }` sites turned out to be local
  // two-literal ternaries over the item type, and both migrated:
  //
  //   - mobile-tasks-source-family.test-support.ts matches the literal `'sendRequest'` in a
  //     source scanner rather than sending anything.
  //   - mobile-tasks-filter-pickers.tsx sends linear.selectWorkspace from an `onSelect` prop of
  //     a native PickerModal. Migrating it needs a recorded wire, and the recorder cannot mount
  //     a module that renders react-native views.
  //   - use-mobile-tasks-route-and-item-state.tsx reads repo.list from a closure inside the
  //     screen-root hook, which calls useLocalSearchParams, useRouter, useHostClient and
  //     useSafeAreaInsets. The recorder has no substitute for any of them.
  //
  // All three need new recorder capability, not another scenario.
  { file: 'src/tasks/mobile-tasks-filter-pickers.tsx', references: 1 },
  { file: 'src/tasks/mobile-tasks-source-family.test-support.ts', references: 1 },
  { file: 'src/tasks/use-mobile-tasks-route-and-item-state.tsx', references: 1 },

  // src/transport/ — what is left of pairing, probing and capability reads after step 4. The
  // protocol gate, the retrying capability probe, the candidate race, credential rotation, the
  // direct-to-relay upgrade, startup pairing recovery and first pairing all send through
  // host-status-probe-operations.ts and mobile-relay-pairing-operations.ts now. Neither file below
  // shares the pending list's stated reason, so each carries its own:
  //
  // Decorates one PairingCandidateClient with director recovery, forwarding whatever method it is
  // handed. It IS the port for the candidate it wraps, so it cannot send through an operation; the
  // one method string it did choose now comes from hostStatusProbe.
  { file: 'src/transport/pairing-relay-candidate.ts', references: 4 },
  // Its sender is the two physical clients' authenticated-but-not-yet-`connected` path, which is
  // not an RpcClient and is unreachable from the recording oracle, so a migration here could not
  // be shown to preserve behaviour. Its method and params are already shared constants.
  { file: 'src/transport/mobile-runtime-capability-negotiation.ts', references: 2 },
  // Sends through hostStatusProbe; the one reference left is its parameter type. Its callers do
  // not share a client type — push-registration.ts holds only the sender — so the parameter names
  // the port itself. It reaches zero when the last such caller migrates.
  { file: 'src/transport/runtime-capability-probe.ts', references: 1 }
]
