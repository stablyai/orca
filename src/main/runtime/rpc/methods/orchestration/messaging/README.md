# Exact question inspection and replies

A question is identified by its message ID together with its Run, Task, and Dispatch. Use the identity recorded in the question payload, not the worker terminal's latest assignment. Inspection is read-only: it does not acknowledge mail, consume a delivery, or answer the question.

```text
orca orchestration question-inspect --id <message_id> --run <run_id> --task <task_id> --dispatch <dispatch_id> --json
orca orchestration reply --mode question --id <message_id> --run <run_id> --task <task_id> --dispatch <dispatch_id> --body "<answer>" --json
orca orchestration reply --mode message --id <message_id> --body "<ordinary reply>" --json
```

## RPC shapes

`orchestration.questionInspect` accepts:

```typescript
{
  id: string
  run: string
  task: string
  dispatch: string
}
```

It returns:

```typescript
{
  question: QuestionRow & {
    task_id: string
    body: string
    options: string[]
  }
}
```

`QuestionRow` includes `message_id`, `run_id`, `dispatch_id`, `asker_handle`, `status` (`pending`, `answered`, or `closed`), `answer_message_id`, `answer_body`, `answered_by_generation`, and the creation/answer/closure timestamps. Answer and closure fields are nullable until set.

The CLI's question mode calls the distinct `orchestration.questionReply` method:

```typescript
{
  id: string
  run: string
  task: string
  dispatch: string
  body: string
  from?: string
  mode?: 'question'
}
```

The response is `{ message: MessageRow, question: QuestionRow, duplicate: boolean }`. Matching selectors, current Dispatch ownership, and pending state are checked within the answer transaction. The answer message, federation relay work, and mutation receipt commit together; recipients are notified after commit. Repeating the same answer returns the original message with `duplicate: true`; changing the answer is rejected. The separate method name makes older hosts fail with `method_not_found` instead of interpreting the strict request as ordinary-message delivery.

The CLI's message mode calls the distinct `orchestration.messageReply` method:

```typescript
{ id: string; body: string; from?: string; run?: string; mode?: 'message' }
```

It returns `{ message: MessageRow }` for ordinary mail. A question-thread identity returns `request_mismatch`. Both explicit reply operations return `method_not_found` on an older host, so selection survives mixed client/server versions.

`orchestration.reply` retains its mixed-version request shape, extended with optional selection:

```typescript
{
  id: string
  body: string
  from?: string
  run?: string
  mode?: 'question' | 'message'
  task?: string
  dispatch?: string
}
```

`mode: 'question'` requires all exact selectors. `mode: 'message'` selects ordinary mail. Omitted `mode` retains server behavior for older clients; the new CLI selects one of the distinct reply methods explicitly.

All reply methods use the existing mutation request ledger. `--retry-request <request_id>` replays the exact request after an uncertain transport outcome; retain the same method, selectors, answer, and sender when retrying. `question-inspect` is a read and has no mutation retry flag.

## Component checks

Run from the repository root:

```text
pnpm test:node src/shared/rpc-contract/orchestration-params.test.ts src/cli/handlers/orchestration-question-cli.test.ts src/main/runtime/orchestration/orchestration-mutation-question-db.test.ts src/main/runtime/rpc/methods/orchestration/messaging/strict-question-reply.test.ts
pnpm tc:node
pnpm tc:cli
pnpm run verify:rpc-params-catalog
pnpm --dir mobile install --frozen-lockfile
pnpm build:mobile-web
pnpm build:orcad
```

For runtime qualification, set `ORCA_BACKGROUND_LAUNCH=1` and a disposable `ORCA_USER_DATA` directory, then start `node out/orcad/orcad.js --port 0 --json`. Pair the packaged CLI using the ready payload's pairing code. Create a synthetic Run, Task, and Dispatch; use `ask --question ... --options json,text --timeout-ms 1` to record a pending question, then run the inspection and reply commands above. Resume the worker's `ask --resume <message_id>` to observe the accepted answer. Keep the Run, Task, Dispatch, question, answer-message, and mutation IDs together with the inspection/replay results.
