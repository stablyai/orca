# High-volume telemetry controls

## Daemon audit eligibility

`daemon_audit_eligibility` retains 0.1% of eligible events (about one in 1,000),
with `sample_rate: 0.001` on each capture. The existing per-adapter five-minute
limit on identical observations still applies before sampling. Changes are
eligible immediately, then independently sampled at the same rate. Local daemon
inventory observations, failure classification, listeners and recovery remain
unchanged and are not sampled.

At 1,000 DAU, assuming one adapter per user active for 24 hours, unchanged
inventory generates at most 288,000 eligible events/day and about 288 sampled
events/day (8,640/month). Adapter churn and state changes add eligible events.
Use the weighted failure-reason chart to guide daemon reliability work; individual
incarnations and their full transition histories will usually be absent.

## Prompt submissions

`agent_prompt_sent` estimates prompt activity by agent, launching surface and
onboarding cohort to guide investment in agent workflows. Use a weighted prompt
volume chart to compare these workflows.

The main-process telemetry client independently retains 1% of prompt events from
all producers, including hooks and renderer IPC. Retained events carry
`sample_rate: 0.01`, owned by the main process. Selection happens before the shared
burst/session caps, so discarded prompts do not consume other events' allowance.
Consent, strict payload validation and person-profile suppression still apply.
Workflow starts and errors retain their existing reporting behavior.

For prompt-volume estimates, sum `1 / sample_rate` for each captured event, using
1 when the property is absent on older builds. Use the recorded rate for each
event, including 0.1 from earlier sampled builds; do not multiply an entire mixed
version period by 100. Raw event counts drop after rollout; distinct-user counts,
funnels and retention cannot be corrected by multiplying by 100. Burst caps,
opt-outs and delivery failures still cause omissions, so weighted totals estimate
eligible telemetry rather than provide an exact prompt ledger.

At 1,000 DAU and 100 prompts/user/day, expected captures fall from 100,000/day
to 1,000/day (30,000/month). This is a statistical expectation, not a hard cap;
the existing 30/event/minute and 1,000 total events/app-session ceilings remain.
The reduction preserves workflow comparisons while removing approximately 99% of
this event's ingestion volume, before other caps and rollout effects.
