---
tags:
  - topic/meta
---

# 🧩 Template: service (agent-memory)

Two formats. **Card** — the service fits in one note (`Services/<service>.md`). **Folder** — a
core/large service (`Services/<service>/` with an overview, — Data, — Interfaces, Business
logic/). References: card — any note under `findocs_back/Services/*.md`; folder —
`Services/sky_ledger/`.

## Card

```markdown
---
tags:
  - type/service
  - project/<slug>
  - repo/<repo>
  - lang/<python|go>
  - domain/<domain>          # closest business domain; pure infra → topic/infra
  - status/<core|legacy|nascent>   # optional
path: src/services/<service>
entrypoints: [<service>/app.py]
tables: []          # only what's verified in code
queues: []          # RabbitMQ
topics_kafka: []
clients_out: []
consumed_by: []
libs: []
---

# <service>

> <1-2 lines: business purpose — what it does and why it exists.>

## Where in code
<entrypoint, key modules with paths, shared libs.>

## Data
<tables/models + where defined. Skip if stateless.>

## Interfaces
<HTTP (main groups, internal routes), queues/topics in+out, outgoing clients (env), who consumes.>

## Business logic
<key algorithms: name — path in code — gist in 2-4 lines.>

## Gotchas
<non-obvious invariants. Skip if none.>

## Links
[[<related>]] · [[<domain>]]
```

## Folder (core service)

```text
Services/<service>/
  <service>.md              # overview + note map (table) + Where in code + business areas + Gotchas; tag + type/moc
  <service> — Data.md     # tables, models, DSN
  <service> — Interfaces.md # HTTP/robot, queues, clients, consumers
  Business logic/<Feature>.md   # 1 feature = 1 note; tag type/logic + code: [files]
```

Rules: content from the code on the default branch (`git show origin/<branch>:<path>`); English
prose, identifiers as in code; ⚠️ = reconstructed indirectly; tables over narrative.
