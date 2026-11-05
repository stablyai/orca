import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []

vi.mock('../session/mobile-image-source-picker', () => ({
  pickMobileImage: (source: string) => {
    calls.push(`pickMobileImage ${source}`)
    return Promise.resolve({ base64: 'BBB=', uri: 'file:///cache/one.png' })
  },
  pickMobileImages: (source: string) => {
    calls.push(`pickMobileImages ${source}`)
    return (async function* () {
      yield { base64: 'CCC=' }
    })()
  }
}))

vi.mock('../session/mobile-file-source-picker', () => ({
  pickMobileFiles: () => {
    calls.push('pickMobileFiles')
    return (async function* () {
      yield { name: 'spec.pdf', mime: 'application/pdf', byteLength: 2, base64: 'AAA=' }
    })()
  }
}))

import { useMediaPicker } from './media-picker'

beforeEach(() => {
  calls.length = 0
})

describe('picking media on a phone', () => {
  it('opens the library picker the screen already opened, source and all', async () => {
    expect(await useMediaPicker().pickImage('library')).toEqual({
      base64: 'BBB=',
      uri: 'file:///cache/one.png'
    })
    expect(calls).toEqual(['pickMobileImage library'])
  })

  it('streams a multi-select from the Files picker', async () => {
    const taken: string[] = []
    for await (const image of useMediaPicker().pickImages('files')) {
      taken.push(image.base64)
    }
    expect(taken).toEqual(['CCC='])
    expect(calls).toEqual(['pickMobileImages files'])
  })

  it('opens the document picker for files of any type', async () => {
    const names: string[] = []
    for await (const file of useMediaPicker().pickFiles()) {
      names.push(file.name)
    }
    expect(names).toEqual(['spec.pdf'])
    expect(calls).toEqual(['pickMobileFiles'])
  })

  it('answers one object across renders, so a caller may hold it in a dependency list', () => {
    expect(useMediaPicker()).toBe(useMediaPicker())
  })
})
