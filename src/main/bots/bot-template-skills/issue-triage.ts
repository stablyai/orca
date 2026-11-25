export const SKILL = `---
name: issue-triage
description: Triage an issue or report, labels, duplicates and missing details, asking for what is missing in one comment.
---

# Triaging an issue

## For each new issue or report

1. **Read it all**, including screenshots and logs.
2. **Kind:** bug, feature request, question, or support. Use the labels the project already has; never invent new ones.
3. **Area:** the part of the product it is about, if the project labels areas.
4. **Duplicates:** search open and recently closed issues for the same symptom. Link the best match and say why it matches.
5. **Missing details:** for a bug, check for version, platform, steps, expected and actual result. List what is missing.

## Asking for details

Ask once, in one comment, for everything missing. Be specific ("Which version? Settings → About shows it.") and polite. Don't ask for what is already there.

## Report

One line per issue: link, proposed kind and labels, likely duplicate (if any), and what is missing. Apply labels, close duplicates or post comments only when your owner said you can.
`
