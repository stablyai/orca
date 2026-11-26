import { describe, expect, it } from 'vitest'
import * as cloud from '../../../cloud/packages/connector-contract/src/slack-answer-presentation'
import * as host from '../../shared/connectors/slack-answer-presentation'
import { matchingSlackPresentation } from './connector-slack-text'

const trend = {
  v: 1,
  text: 'Builds took less time this week.',
  visual: {
    kind: 'line',
    title: 'Daily median build time',
    axis: 'Day',
    unit: 'min',
    source: 'Build report',
    window: { from: '2026-11-20T00:00:00Z', to: '2026-11-22T00:00:00Z' },
    points: [
      { at: '2026-11-20T00:00:00Z', label: 'Nov 20' },
      { at: '2026-11-21T00:00:00Z', label: 'Nov 21' },
      { at: '2026-11-22T00:00:00Z', label: 'Nov 22' }
    ],
    series: [{ label: 'Median', values: [6.2, 5.1, 3.7] }]
  }
}

describe.each([host, cloud])('Slack answer presentation', (contract) => {
  const parse = contract.SlackAnswerPresentationSchema.safeParse

  it('keeps every value and its unit in the text projection', () => {
    expect(contract.slackAnswerText(contract.SlackAnswerPresentationSchema.parse(trend))).toBe(
      'Builds took less time this week.\n\nDaily median build time\nSource: Build report\n' +
        '2026-11-20T00:00:00Z to 2026-11-22T00:00:00Z\nCategories: Day\n' +
        'Nov 20: Median 6.2 min\nNov 21: Median 5.1 min\nNov 22: Median 3.7 min'
    )
  })

  it('rejects unknown destinations, unsafe strings, uneven time steps and incomplete data', () => {
    expect(parse({ ...trend, channel: 'C1234' }).success).toBe(false)
    expect(
      parse({ ...trend, visual: { ...trend.visual, source: 'https://example.test' } }).success
    ).toBe(false)
    expect(parse({ ...trend, text: '<!channel> Builds got faster.' }).success).toBe(false)
    expect(parse({ ...trend, text: 'x'.repeat(2_900) }).success).toBe(false)
    expect(
      parse({
        ...trend,
        visual: { ...trend.visual, series: [{ label: 'Median', values: [6.2, 3.7] }] }
      }).success
    ).toBe(false)
    expect(
      parse({
        ...trend,
        visual: { ...trend.visual, series: [{ label: 'Median', values: [6.2, Infinity, 3.7] }] }
      }).success
    ).toBe(false)
    const [first, second, third] = trend.visual.points
    expect(
      parse({
        ...trend,
        visual: {
          ...trend.visual,
          points: [first, { ...second, at: '2026-11-21T01:00:00Z' }, third]
        }
      }).success
    ).toBe(false)
  })

  it('projects the supplied source filename while keeping link-like sources out', () => {
    const visual = {
      kind: 'bar',
      title: 'Regional sales',
      source: 'regional-sales.csv',
      axis: 'Region',
      unit: 'USD',
      labels: ['East', 'West'],
      series: [{ label: 'Sales', values: [6200, 2600] }]
    }
    const answer = { v: 1, text: 'East led by $3,600.', visual }
    const parsed = contract.SlackAnswerPresentationSchema.parse(answer)
    expect(contract.slackAnswerText(parsed)).toContain('Source: regional-sales.csv')
    expect(matchingSlackPresentation(parsed, contract.slackAnswerText(parsed))).toBe(true)
    for (const source of [
      'https://regional-sales.csv',
      'www.regional-sales.csv',
      'regional-sales.com',
      'regional-sales.com.csv',
      'regional-sales.csv/preview',
      'sales@regional-sales.csv',
      '<https://example.com|regional-sales.csv>'
    ]) {
      expect(parse({ ...answer, visual: { ...visual, source } }).success).toBe(false)
    }
  })

  it('requires a unique row header and consistent numeric units for tables', () => {
    const visual = {
      kind: 'table',
      title: 'Build stages',
      source: 'Build report',
      columns: [{ label: 'Stage' }, { label: 'Time', unit: 's' }],
      rows: [
        ['Install', 14],
        ['Compile', 87]
      ]
    }
    const parsed = contract.SlackAnswerPresentationSchema.parse({
      v: 1,
      text: 'Compile took longest.',
      visual
    })
    expect(contract.slackAnswerText(parsed)).toContain('Stage: Compile, Time: 87 s')
    expect(
      parse({
        v: 1,
        text: 'Build stages',
        visual: {
          ...visual,
          rows: [
            ['Compile', 87],
            ['compile', 92]
          ]
        }
      }).success
    ).toBe(false)
    expect(
      parse({
        v: 1,
        text: 'Build stages',
        visual: {
          ...visual,
          rows: [
            ['Install', 14],
            ['Compile', 'unknown']
          ]
        }
      }).success
    ).toBe(false)
  })
})

it('checks chart axes under the Slack path redaction policy as well as prose', () => {
  const candidate = host.SlackAnswerPresentationSchema.parse({
    ...trend,
    visual: { ...trend.visual, axis: 'C:\\Users\\me\\private' }
  })
  expect(matchingSlackPresentation(candidate, host.slackAnswerText(candidate))).toBe(false)
})
