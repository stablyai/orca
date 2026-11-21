# Agent teams (Phase 4)

Flag: `FORK_FEATURES.agentTeams` (`src/shared/orca-fork/fork-features.ts`).

## What the owner sees

Bot settings › Agent › **Can build a team** (off by default). When on:

- `orca bot create --offer` from that bot creates the bot right away (same path as pressing Create
  bot on the card, `bots.createFromOffer`), up to 5 a day. The card stays in the chat and shows the bot
  as created: that is the audit line.
- The new bot and the lead join the bot group **"<Lead>’s team"**, created the first time and
  extended after that.
- Both are told how to hand work to each other: `orca bot items add --for <bot>` and
  `orca orchestration send --to bot:<bot> --type handoff`. Bot-to-bot mail and items already run
  without owner approval upstream; the team group is their shared room.

## Where it runs

All of it runs on the **bot's host** (the runtime that owns the bot):

- Bots on the Mac: works with the fork desktop app.
- Bots on a VPS: needs the **fork `orca-server`** on that VPS (new RPCs `orcaFork.teams.get/set`, the
  auto-accept in `bots.createOffer`). Against a stock 1.4.266 server the switch is hidden and offers
  stay cards, exactly as upstream. A stock 1.4.266 desktop paired to a fork server keeps working; it
  just has no switch (the setting is stored on the server, so a switch set from the fork desktop still
  applies).

Settings live in `<userData>/orca-fork-agent-teams.json` on that host, outside every bot home, and only
the owner (desktop or paired device) can change them.

## Not yet

- Inside the group room, a bot's @-handoff still has to serve an owner message there (upstream's
  group peer-request rule). Teams delegate through Home-chat mail and items instead.
- Cap is fixed at 5/day from the UI (the RPC takes `dailyCap` 1–20).
