// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { filteredDatalistOptions } from './offscreen-page-datalist'

function input(value: string, extra = ''): HTMLInputElement {
  document.body.innerHTML = `<input list="l" ${extra}><datalist id="l">
    <option>apple</option><option value="apricot">Apricot fruit</option>
    <option value="banana" label="Yellow Banana"></option><option value="" >empty</option>
    <option value="cherry" disabled></option></datalist>`
  const element = document.querySelector('input')
  if (!element) {
    throw new Error('no input')
  }
  element.value = value
  return element
}

describe('filteredDatalistOptions', () => {
  it('lists enabled options with a value, with a label only when it differs', () => {
    expect(filteredDatalistOptions(input(''))).toEqual([
      { value: 'apple', label: '' },
      { value: 'apricot', label: 'Apricot fruit' },
      { value: 'banana', label: 'Yellow Banana' }
    ])
  })

  it('keeps options whose value or label holds every typed word, ignoring case and spaces', () => {
    expect(filteredDatalistOptions(input('AP')).map((item) => item.value)).toEqual([
      'apple',
      'apricot'
    ])
    expect(filteredDatalistOptions(input('yellow ban')).map((item) => item.value)).toEqual([
      'banana'
    ])
    expect(filteredDatalistOptions(input('fruit apr')).map((item) => item.value)).toEqual([
      'apricot'
    ])
  })

  it('filters a multiple email field by its last address', () => {
    expect(
      filteredDatalistOptions(input('x@y.z, ban', 'type="email" multiple')).map(
        (item) => item.value
      )
    ).toEqual(['banana'])
  })
})
