export const SKILL = `---
name: feedback-themes
description: Group feedback into themes with counts and short quotes, linking issues that already exist.
---

# Feedback themes

## Collect

- Read every message in the period and channels you were given. Count people, not messages: one person repeating themselves counts once.
- Skip thanks, chatter and messages you can't tie to the product.

## Group

- A theme is one problem or wish, named in the user's words ("pasting in the terminal drops lines"), not a product area ("terminal").
- Put each message in at most one theme. Leave out themes with a single person unless they are severe.

## For each theme

- How many people, and whether that grew since last time.
- One or two short quotes, as written, with a link.
- The existing issue it matches, if there is one; otherwise say there's none.

## Report

Biggest theme first. Then a short "new this time" line for themes that weren't there before. Keep it to what fits on one screen.
`
