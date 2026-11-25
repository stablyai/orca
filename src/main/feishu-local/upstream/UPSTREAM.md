# OpenClaw Lark card components

Source: https://github.com/larksuite/openclaw-lark/tree/dde0be3680d6fd5443cab426c8f4b3216266346a

Pinned commit: dde0be3680d6fd5443cab426c8f4b3216266346a
License: MIT; copyright and license retained in LICENSE.

Imported components:

- src/card/flush-controller.ts: scheduling primitive, local constants import and repository formatting.
- src/card/reply-dispatcher-types.ts: throttle constants.
- src/card/builder.ts: tool-step and active panel builders, extracted into small modules.

Orca adaptations: Chinese default labels, typed injected transport, no OpenClaw runtime imports, no raw tool output or reasoning content. Rendering and event projection remain separate. CardKit requests follow src/card/cardkit.ts using Orca's existing authenticated CLI transport.

Keep this pin when merging upstream updates; compare the named functions and rerun persistence, event-scope and streaming acceptance checks.
