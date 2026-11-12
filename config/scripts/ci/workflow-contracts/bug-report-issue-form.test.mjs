import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bugForm, readIssueForm } from './issue-os-labeler-script-runner.mjs'

// Constraints from GitHub's "Syntax for GitHub's form schema" and issue-form syntax docs.
const TOP_LEVEL_KEYS = [
  'name',
  'description',
  'title',
  'type',
  'labels',
  'assignees',
  'projects',
  'body'
]
const FIELD_KEYS = ['type', 'id', 'attributes', 'validations']
const ATTRIBUTE_KEYS = {
  markdown: ['value'],
  input: ['label', 'description', 'placeholder', 'value'],
  textarea: ['label', 'description', 'placeholder', 'value', 'render'],
  dropdown: ['label', 'description', 'multiple', 'options', 'default'],
  checkboxes: ['label', 'description', 'options']
}

const fields = bugForm.body.filter((field) => field.type !== 'markdown')
const field = (id) => bugForm.body.find((candidate) => candidate.id === id)

describe.each(['bug_report', 'feature_request', 'other'])('%s form schema', (name) => {
  const form = readIssueForm(name)

  it('uses only documented keys and types', () => {
    expect(TOP_LEVEL_KEYS).toEqual(expect.arrayContaining(Object.keys(form)))
    expect(form.name).toEqual(expect.any(String))
    expect(form.description).toEqual(expect.any(String))
    expect(form.body.some((item) => item.type !== 'markdown')).toBe(true)

    for (const item of form.body) {
      expect(Object.keys(ATTRIBUTE_KEYS)).toContain(item.type)
      // Unsupported keys such as `if`/`visible` would make GitHub reject the whole form.
      expect(FIELD_KEYS).toEqual(expect.arrayContaining(Object.keys(item)))
      expect(ATTRIBUTE_KEYS[item.type]).toEqual(
        expect.arrayContaining(Object.keys(item.attributes))
      )
      if (item.type === 'markdown') {
        expect(item.attributes.value.trim()).not.toBe('')
        expect(item.validations).toBeUndefined()
        continue
      }
      expect(item.attributes.label.trim()).not.toBe('')
      expect(Object.keys(item.validations)).toEqual(['required'])
      expect(typeof item.validations.required).toBe('boolean')
    }
  })

  it('has unique valid ids and labels', () => {
    const inputs = form.body.filter((item) => item.type !== 'markdown')
    const ids = inputs.map((item) => item.id)
    const labels = inputs.map((item) => item.attributes.label)
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
    }
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('has unique, non-empty string dropdown options', () => {
    for (const item of form.body.filter((candidate) => candidate.type === 'dropdown')) {
      const { options } = item.attributes
      expect(options.length).toBeGreaterThan(0)
      for (const option of options) {
        expect(typeof option).toBe('string')
        expect(option.trim()).toBe(option)
        expect(option).not.toBe('')
        // GitHub reserves "None" for its own unselected choice on optional dropdowns.
        expect(option.toLowerCase()).not.toBe('none')
      }
      expect(new Set(options.map((option) => option.toLowerCase())).size).toBe(options.length)
    }
  })
})

describe('bug report form content', () => {
  it('keeps the English request exactly as on main', () => {
    expect(bugForm.body[0]).toEqual({
      type: 'markdown',
      attributes: {
        value:
          'Use this form for Orca bugs. Include enough detail for someone else to reproduce the issue.\n\nPlease write your issue in English.\n'
      }
    })
    expect(bugForm.labels).toEqual(['bug'])
    expect(bugForm.type).toBe('Bug')
  })

  it('asks for the fields in the reviewed order with the reviewed required flags', () => {
    expect(
      fields.map((item) => [item.id, item.type, item.attributes.label, item.validations.required])
    ).toEqual([
      ['where', 'dropdown', 'Where were you using Orca?', true],
      ['os', 'dropdown', 'Operating system', true],
      ['remote_os', 'dropdown', 'Remote host operating system', false],
      ['orca_version', 'input', 'Orca version', false],
      ['details', 'textarea', 'Details', true]
    ])
  })

  it('offers the reviewed options', () => {
    expect(field('where').attributes.options).toEqual([
      'Desktop only',
      'Desktop + SSH host',
      'Desktop + Orca server',
      'Desktop + WSL',
      'Mobile app',
      'Web browser',
      'Other'
    ])
    expect(field('os').attributes.options).toEqual([
      'macOS',
      'Windows',
      'Linux',
      'iOS',
      'Android',
      'Other'
    ])
    expect(field('remote_os').attributes.options).toEqual([
      'Linux',
      'macOS',
      'Windows',
      'Other',
      'Not sure'
    ])
    expect(fields.every((item) => item.attributes.multiple === undefined)).toBe(true)
  })

  it('uses the reviewed help copy', () => {
    expect(field('where').attributes.description).toBe('Where you saw the bug.')
    expect(field('os').attributes.description).toBe(
      'The device you were using. WSL: pick Windows. Phone: pick iOS or Android.'
    )
    expect(field('remote_os').attributes.description).toBe('Only for SSH, Orca server or web.')
    expect(field('orca_version').attributes.description).toBe(
      'macOS: Orca > About Orca. Windows/Linux: Help > About Orca. Mobile: Settings > About.'
    )
    expect(field('orca_version').attributes.placeholder).toBe('v1.4.2')
  })

  it('points at About entries that exist in the desktop menu and the mobile settings', () => {
    const menu = readFileSync('src/main/menu/register-app-menu.ts', 'utf8')
    expect(menu.match(/labeledAppMenuRole\('about', 'menu\.about', 'About Orca'\)/g)).toHaveLength(
      2
    )
    expect(menu).toMatch(/const helpMenu[\s\S]*?isMac\s*\? \[\][\s\S]*?'About Orca'/)
    const settings = readFileSync('mobile/src/settings/mobile-settings-menu-items.ts', 'utf8')
    expect(settings).toMatch(/translate\('settings\.menuItems\.about', 'About'\)/)
  })
})
