---
tags:
  - topic/meta
---

# 📦 Template: repository (agent-memory)

Repository notes live in `Projects/<Project>/<repo>/`. Reference: `Projects/MySky/custom-pricelist-api/`.

```
<repo>/
  <repo>.md                 # overview: purpose, note map, Where in code, commands; tags type/overview + type/moc
  <repo> — Architecture.md   # layers, DI, pipelines, deploy (+Mermaid)
  <repo> — Data.md        # domain model, tables, migrations, invariants (+ER Mermaid)
  <repo> — Interfaces.md     # HTTP, buses, outgoing clients, consumers
  Business logic/<Feature>.md   # 1 feature = 1 note (type/logic + code:)
  Services/                  # monorepo only: microservice cards/folders
```

Overview frontmatter:

```yaml
---
tags: [type/overview, type/moc, project/<slug>, repo/<repo>, lang/<lang>, domain/<domain>]
path: ~/JOB/.../<repo>
branch: origin/<master|main|trunk>
entrypoints: [...]
infra: <prod host, if known>
---
```

Rules: facts from the code on the default branch; English prose; tables over narrative; the
overview must include a "Note map" (a table with links and each note's area of responsibility).
