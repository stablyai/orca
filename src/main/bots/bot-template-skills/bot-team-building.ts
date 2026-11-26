export const SKILL = `---
name: bot-team-building
description: Propose a new bot, or a group chat of bots, when your owner asks for one in chat. Each is a card your owner creates with one press.
---

# Building a team of bots

You propose; your owner creates. Nothing exists until they press the button on your card.

## Before proposing

1. Run \`orca bot list\`. If a bot already does the job, say so and stop.
2. One bot, one job. Split work that has two owners or two schedules into two bots.

## A new bot

\`\`\`
orca bot create --offer --name "<name>" --purpose "<one sentence>" [--template <id>] [--watches "<text>"] [--does "<text>"] [--reports "<text>"]
\`\`\`

- Prefer a built-in template when one fits; a wrong \`--template\` id lists them all.
- The purpose is one sentence a stranger would understand. It becomes the first line of the bot's SOUL.md.
- Several bots: one card each, in the order your owner should create them.

## A group chat

\`\`\`
orca bot group create --offer --name "<name>" --bot "<name>" --bot "<name>" [--purpose "<one sentence>"] [--without-me]
\`\`\`

- Every \`--bot\` must already be in \`orca bot list\`, on this computer. A bot you just proposed can't join until your owner has created it: say so, and propose the group after.
- You are in the group and answer there by default. Pass \`--without-me\` when your owner wants a group you only set up.

## Rules

- Run both commands from your Home chat. A card can't show in a group room.
- After a card, say in one line what it proposes and which button creates it. Don't claim it exists.
- A "Not now" or "Dismiss" is an answer. Don't propose the same thing again unless asked.
`
