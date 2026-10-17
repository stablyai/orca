import { expect, it } from 'vitest'
import { claudeContentBlocks } from './transcript-record-blocks'

it('keeps the owning-host path as the only source of a historical image', () => {
  expect(
    claudeContentBlocks([
      {
        type: 'image',
        path: '/host/agent-session-attachments/upload/image.png',
        source: { url: 'https://expired.example/image.png' },
        alt: 'Screenshot'
      }
    ])
  ).toEqual([
    {
      type: 'image-ref',
      path: '/host/agent-session-attachments/upload/image.png',
      alt: 'Screenshot'
    }
  ])
})

it('retains a URL when the historical image has no owning-host path', () => {
  expect(
    claudeContentBlocks([{ type: 'image', source: { url: 'https://example.test/image.png' } }])
  ).toEqual([{ type: 'image-ref', url: 'https://example.test/image.png' }])
})

it('prefers a usable URL over a path outside the attachment store', () => {
  expect(
    claudeContentBlocks([
      { type: 'image', path: '/tmp/image.png', source: { url: 'https://example.test/image.png' } }
    ])
  ).toEqual([{ type: 'image-ref', url: 'https://example.test/image.png' }])
})

it('retains a path outside the attachment store when no URL is available', () => {
  expect(claudeContentBlocks([{ type: 'image', path: '/tmp/image.png' }])).toEqual([
    { type: 'image-ref', path: '/tmp/image.png' }
  ])
})

it('keeps Windows attachment paths ahead of a historical URL', () => {
  const path = 'C:\\Orca\\agent-session-attachments\\upload\\image.png'
  expect(
    claudeContentBlocks([{ type: 'image', path, url: 'https://expired.example/image.png' }])
  ).toEqual([{ type: 'image-ref', path }])
})
