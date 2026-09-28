import type { KiroUsageQuota } from '../../shared/kiro-usage-types'
import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'

// Strip ANSI escapes (shared stripper) and carriage returns so the meter text
// parses regardless of the terminal styling kiro-cli emits.
export function stripAnsi(text: string): string {
  return stripAnsiEscapeSequences(text).replace(/\r/g, '')
}

// Parse the `/usage` meter, e.g.:
//   Estimated Usage | resets on 2026-10-01 | KIRO PRO
//   Credits (132.35 of 1000 covered in plan)
//   ████…████ 13.2%
// Returns null when the "of N covered in plan" line is absent.
export function parseKiroUsageOutput(rawOutput: string): KiroUsageQuota | null {
  const text = stripAnsi(rawOutput)

  const credits = /\(\s*([\d.]+)\s+of\s+([\d.]+)\s+covered in plan\)/i.exec(text)
  if (!credits) {
    return null
  }
  const used = Number.parseFloat(credits[1])
  const limit = Number.parseFloat(credits[2])
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
    return null
  }

  // Prefer the CLI's own percentage; fall back to used/limit when absent.
  const pctMatch = /([\d.]+)\s*%/.exec(text)
  const reportedPercent = pctMatch ? Number.parseFloat(pctMatch[1]) : Number.NaN
  const usedPercent = Number.isFinite(reportedPercent)
    ? reportedPercent
    : Math.round((used / limit) * 1000) / 10

  const resetsMatch = /resets on\s+(\d{4}-\d{2}-\d{2})/i.exec(text)
  const planMatch = /\|\s*([A-Z][A-Za-z0-9 ]+?)\s*(?:\n|$)/.exec(text)

  return {
    used,
    limit,
    usedPercent,
    resetsOn: resetsMatch ? resetsMatch[1] : null,
    plan: planMatch ? planMatch[1].trim() : null
  }
}
