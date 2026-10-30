import { describe, expect, it } from 'vitest'
import type { YouTrackFieldSchema } from '../../shared/youtrack-types'
import { buildFieldPayload, DEFAULT_WORK_TIME, parsePeriodMinutes } from './field-payload'
import { toFieldSchema } from './project-fields'

function schema(overrides: Partial<YouTrackFieldSchema>): YouTrackFieldSchema {
  return {
    name: 'Field',
    kind: 'enum',
    multi: false,
    required: false,
    emptyText: null,
    options: [],
    defaults: [],
    ...overrides
  }
}

describe('parsePeriodMinutes', () => {
  it('reads English and Russian units with the instance work day', () => {
    expect(parsePeriodMinutes('1w 2d 3h 30m', DEFAULT_WORK_TIME)).toBe(2400 + 960 + 180 + 30)
    expect(parsePeriodMinutes('2д 4ч', DEFAULT_WORK_TIME)).toBe(1200)
    expect(parsePeriodMinutes('1d', { minutesADay: 360, daysAWeek: 5 })).toBe(360)
    expect(parsePeriodMinutes('90', DEFAULT_WORK_TIME)).toBe(90)
  })

  it('rejects text it cannot fully read', () => {
    expect(parsePeriodMinutes('2 days', DEFAULT_WORK_TIME)).toBeNull()
    expect(parsePeriodMinutes('soon', DEFAULT_WORK_TIME)).toBeNull()
  })
})

describe('buildFieldPayload', () => {
  const release = schema({
    name: 'Release',
    kind: 'version',
    multi: true,
    options: [
      { value: '1.0', label: '1.0' },
      { value: '1.1', label: '1.1' }
    ]
  })

  it('writes multi-value option fields by name', () => {
    expect(buildFieldPayload(release, ['1.0', '1.1'])).toEqual({
      ok: true,
      payload: {
        name: 'Release',
        $type: 'MultiVersionIssueCustomField',
        value: [{ name: '1.0' }, { name: '1.1' }]
      }
    })
  })

  it('writes users by login and clears with an empty selection', () => {
    const assignee = schema({
      name: 'Assignee',
      kind: 'user',
      options: [{ value: 'me', label: 'Me' }]
    })
    expect(buildFieldPayload(assignee, ['me'])).toMatchObject({
      payload: { $type: 'SingleUserIssueCustomField', value: { login: 'me' } }
    })
    expect(buildFieldPayload(assignee, [])).toMatchObject({ payload: { value: null } })
  })

  it('refuses values outside the project bundle', () => {
    expect(buildFieldPayload(release, ['9.9'])).toEqual({
      ok: false,
      error: '"9.9" is not an allowed value for Release.'
    })
  })

  it('refuses raw state writes so workflow transitions are not bypassed', () => {
    const state = schema({
      name: 'State',
      kind: 'state',
      options: [{ value: 'Fixed', label: 'Fixed' }]
    })
    expect(buildFieldPayload(state, ['Fixed'])).toMatchObject({ ok: false })
  })

  it('converts scalar inputs to the typed values YouTrack stores', () => {
    expect(
      buildFieldPayload(schema({ name: 'Estimation', kind: 'period' }), ['1d 2h'])
    ).toMatchObject({
      payload: { $type: 'PeriodIssueCustomField', value: { minutes: 600 } }
    })
    expect(buildFieldPayload(schema({ name: 'Due', kind: 'date' }), ['2026-10-31'])).toMatchObject({
      payload: { $type: 'DateIssueCustomField', value: Date.UTC(2026, 9, 31, 12) }
    })
    expect(
      buildFieldPayload(schema({ name: 'Starts', kind: 'datetime' }), ['2026-10-31T09:30'])
    ).toMatchObject({
      payload: { $type: 'SimpleIssueCustomField', value: new Date('2026-10-31T09:30').getTime() }
    })
    expect(buildFieldPayload(schema({ name: 'Points', kind: 'integer' }), ['x'])).toMatchObject({
      ok: false
    })
    expect(buildFieldPayload(schema({ name: 'Notes', kind: 'text' }), ['hi'])).toMatchObject({
      payload: { $type: 'TextIssueCustomField', value: { $type: 'TextFieldValue', text: 'hi' } }
    })
  })
})

describe('toFieldSchema', () => {
  it('maps project fields, user bundles, requiredness, and defaults', () => {
    expect(
      toFieldSchema({
        canBeEmpty: false,
        emptyFieldText: 'Unassigned',
        field: { name: 'Assignee', fieldType: { id: 'user[1]', isMultiValue: false } },
        bundle: {
          aggregatedUsers: [
            { login: 'zed', fullName: 'Zed' },
            { login: 'amy', fullName: 'Amy' },
            { login: 'gone', fullName: 'Gone', banned: true }
          ]
        },
        defaultValues: [{ login: 'amy' }]
      })
    ).toEqual({
      name: 'Assignee',
      kind: 'user',
      multi: false,
      required: true,
      emptyText: 'Unassigned',
      options: [
        { value: 'amy', label: 'Amy' },
        { value: 'zed', label: 'Zed' }
      ],
      defaults: ['amy']
    })
    expect(
      toFieldSchema({ field: { name: 'Estimation', fieldType: { id: 'period' } } })
    ).toMatchObject({ kind: 'period', multi: false, required: false })
  })
})
