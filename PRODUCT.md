# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Electron + React 19 + Tailwind 4 + shadcn/ui (new-york-v4) + xterm.js; Vite/rolldown build; pnpm monorepo with mobile (Expo) companion. Existing codebase — stack is fixed.

## Users

Primary user (confirmed): Milan — a professional developer running this as a personal daily driver. Secondary (inferred from codebase): developers orchestrating multiple AI coding agents.

## Product Purpose

MCode is a desktop IDE/orchestrator for parallel agentic development: it runs multiple AI CLI agents (Codex, Claude Code, OpenCode, Pi, Gemini, Amp, Antigravity, Copilot, Devin, Kimi, Grok) side-by-side, each in its own isolated git worktree, tracked in one place. Success = comparing and merging agent output with minimal context switching.

## Positioning

The orchestration layer: fan one prompt across many agents in parallel worktrees, watch them all in one surface, merge the winner. Neighboring editors (VS Code, Zed) host one agent at a time; MCode's mechanism is fleet orchestration.

## Operating Context

- Dense, long-session developer tool: terminals (xterm/WebGL), embedded Chromium browser with Design Mode, Monaco editor, git graph, PR review surfaces.
- Integrations: GitHub, GitLab, Linear, Jira, Bitbucket, Azure DevOps; SSH remote worktrees; mobile companion app for monitoring/steering agents.
- Windows/macOS/Linux desktop app; light and dark themes; i18n (6 languages).

## Capabilities and Constraints

- 1,755 renderer components; theming is centralized via CSS variables in `src/renderer/src/assets/main.css` (~3,000 lines) consumed through Tailwind 4 `@theme inline` tokens.
- Terminal rendering (xterm WebGL), Monaco, and git-graph colors have dedicated token groups that must stay legible in both themes.
- Functional behavior, keyboard shortcuts, and layout mechanics must be preserved; this is a redesign, not a rearchitecture.
- Rebrand from Orca is complete (name, identifiers, logo/icon artwork — all assets regenerate from `resources/logo.svg` via `config/scripts/render-brand-assets.mjs`).

## Brand Commitments

- Name: MCode (confirmed via completed rebrand).
- Typeface: Geist variable font is bundled and loaded app-wide (incumbent commitment, no user objection).
- No binding color or aesthetic constraints (confirmed: user grants creative freedom, wants modern).

## Evidence on Hand

- Full source of incumbent UI as anti-reference for the redesign world.
- Running dev instance (Electron + Vite dev server on localhost:5173, DevTools CDP on 127.0.0.1:9512) usable for live screenshots and verification.

## Product Principles

1. Daily-driver comfort first: scanability and calm density over spectacle; personality in precise details.
2. Fleet clarity: the state of many agents/worktrees must be readable at a glance (status colors are core infrastructure, not decoration).
3. Terminals are the heart: chrome must recede so terminal content dominates.
4. One coherent world: tokens over per-component styling; light and dark are first-class equals.

## Accessibility & Inclusion

- Standard desktop-app contrast expectations; both themes must meet readable contrast for text and status colors.
- Touch-reveal affordances already gated behind `can-hover:` variant — preserve.

## Open Decisions

- Visual world: delegated to designer (user granted creative freedom, wants modern) — decided in new-work, recorded in DESIGN.md.
