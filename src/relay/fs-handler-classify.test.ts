import { describe, expect, it } from 'vitest'
import { resolvePreviewableBinaryMime } from './fs-handler-utils'

describe('resolvePreviewableBinaryMime', () => {
  it('classifies spreadsheets', () => {
    const resolved = resolvePreviewableBinaryMime('.xlsx')
    expect(resolved.spreadsheetMimeType).toBeTruthy()
    expect(resolved.binaryMimeType).toBe(resolved.spreadsheetMimeType)
    expect(resolved.imageMimeType).toBeUndefined()
    expect(resolved.officeDocumentMimeType).toBeUndefined()
  })

  it('classifies office documents', () => {
    const resolved = resolvePreviewableBinaryMime('.docx')
    expect(resolved.officeDocumentMimeType).toContain('wordprocessingml')
    expect(resolved.binaryMimeType).toBe(resolved.officeDocumentMimeType)
    expect(resolved.imageMimeType).toBeUndefined()
    expect(resolved.spreadsheetMimeType).toBeUndefined()
  })

  it('classifies images', () => {
    const resolved = resolvePreviewableBinaryMime('.png')
    expect(resolved.imageMimeType).toBeTruthy()
    expect(resolved.binaryMimeType).toBe(resolved.imageMimeType)
    expect(resolved.officeDocumentMimeType).toBeUndefined()
  })

  it('leaves plain text unclassified', () => {
    const resolved = resolvePreviewableBinaryMime('.txt')
    expect(resolved.binaryMimeType).toBeUndefined()
    expect(resolved.imageMimeType).toBeUndefined()
    expect(resolved.spreadsheetMimeType).toBeUndefined()
    expect(resolved.officeDocumentMimeType).toBeUndefined()
  })
})
