import { describe, expect, it } from 'vitest'
import { planTuiWheelReports } from './tui-wheel-pacing'

describe('planTuiWheelReports', () => {
  it('sends one report per whole row to a program that moves a row per report', () => {
    expect(planTuiWheelReports('one-row', 2.7, 500)).toEqual({ reports: 2, rows: 2 })
    expect(planTuiWheelReports('one-row', -1.2, 500)).toEqual({ reports: -1, rows: -1 })
  })

  it('sends Claude Code one report per row while reports stay within its flood gap', () => {
    expect(planTuiWheelReports('claude-code', 2.4, 16)).toEqual({ reports: 2, rows: 2 })
  })

  it('leaves the lead a notch built until the finger comes back past it', () => {
    // Three rows sent for 1.6 of travel leave Claude Code 1.4 rows ahead of a resting finger.
    expect(planTuiWheelReports('claude-code', -1.4, 16, 1)).toEqual({ reports: 0, rows: 0 })
    expect(planTuiWheelReports('claude-code', -2.6, 16, 1)).toEqual({ reports: -1, rows: -1 })
    expect(planTuiWheelReports('one-row', -1.4, 16, 1)).toEqual({ reports: -1, rows: -1 })
  })

  it('waits out the gap where Claude Code could read a report either way', () => {
    expect(planTuiWheelReports('claude-code', 2.4, 40)).toEqual({ reports: 0, rows: 0 })
    expect(planTuiWheelReports('claude-code', 2.4, 60)).toEqual({ reports: 1, rows: 3 })
  })

  it('holds a lone Claude Code report until the finger is nearer its three-row notch', () => {
    expect(planTuiWheelReports('claude-code', 1.4, 200)).toEqual({ reports: 0, rows: 0 })
    expect(planTuiWheelReports('claude-code', 1.6, 200)).toEqual({ reports: 1, rows: 3 })
    expect(planTuiWheelReports('claude-code', -5.4, 200)).toEqual({ reports: -3, rows: -5 })
  })
})
