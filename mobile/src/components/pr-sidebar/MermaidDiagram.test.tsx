import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyMobileColorScheme } from '../../theme/mobile-theme'

const { initialize, render } = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }))
vi.mock('./mermaid-page-engine.generated', () => ({ default: { initialize, render } }))
vi.mock('../../../../src/shared/mermaid-flowchart-contrast', () => ({
  readableMermaidFlowchartSvg: (svg: string) => svg
}))
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
import { MermaidDiagram } from './MermaidDiagram'
import { MobileTranscriptLayoutContext } from '../mobile-transcript-layout'

function pendingDiagram() {
  let resolve: (result: { svg: string }) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<{ svg: string }>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

let renderer: ReactTestRenderer | undefined
const hosts: { innerHTML: string; replaceChildren: () => void }[] = []
function mount(sources: string[]) {
  const children = sources.map((source, index) =>
    createElement(MermaidDiagram, { key: index, source, base: 15 })
  )
  const release = vi.fn()
  const register = vi.fn(() => release)
  act(() => {
    renderer = create(
      createElement(MobileTranscriptLayoutContext.Provider, { value: register }, ...children),
      {
        createNodeMock: () => {
          const host = {
            innerHTML: '',
            replaceChildren() {
              this.innerHTML = ''
            }
          }
          hosts.push(host)
          return host
        }
      }
    )
  })
  return { register, release }
}
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  applyMobileColorScheme('dark')
  hosts.length = 0
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('page Mermaid shared render ownership', () => {
  it('finishes one diagram before initializing the next and continues after a failure', async () => {
    const first = pendingDiagram()
    render
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ svg: '<svg>second</svg>' })
    mount(['flowchart TD\nA-->B', 'flowchart LR\nC-->D'])
    await act(async () => {
      await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1))
    })
    expect(initialize).toHaveBeenCalledTimes(1)
    await act(async () => {
      first.reject(new Error('Invalid diagram'))
      await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2))
    })
    expect(hosts.some((host) => host.innerHTML === '<svg>second</svg>')).toBe(true)
  })

  it('skips obsolete queued themes and never publishes the old-theme result', async () => {
    const first = pendingDiagram()
    render
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ svg: '<svg>light</svg>' })
    mount(['flowchart TD\nA-->B', 'flowchart LR\nC-->D'])
    await act(async () => {
      await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1))
    })
    act(() => applyMobileColorScheme('light'))
    expect(initialize).toHaveBeenCalledTimes(1)
    await act(async () => {
      first.resolve({ svg: '<svg>obsolete</svg>' })
      await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(3))
    })
    expect(hosts.every((host) => !host.innerHTML.includes('obsolete'))).toBe(true)
    expect(hosts.filter((host) => host.innerHTML.includes('light'))).toHaveLength(2)
  })
})

it('retries a failed diagram on theme changes, including a rapid return to its original theme', async () => {
  const light = pendingDiagram()
  render
    .mockRejectedValueOnce(new Error('Render failed'))
    .mockImplementationOnce(() => light.promise)
    .mockResolvedValue({ svg: '<svg>dark retry</svg>' })
  mount(['flowchart TD\nA-->B'])
  await act(async () => {
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1))
  })
  expect(
    renderer!.root.findAll((node) => node.props?.testID === 'mermaid-diagram-source')
  ).toHaveLength(1)
  act(() => applyMobileColorScheme('light'))
  await act(async () => {
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2))
  })
  act(() => applyMobileColorScheme('dark'))
  await act(async () => {
    light.resolve({ svg: '<svg>obsolete light</svg>' })
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(3))
  })
  expect(hosts.some((host) => host.innerHTML.includes('dark retry'))).toBe(true)
  expect(hosts.some((host) => host.innerHTML.includes('obsolete light'))).toBe(false)
  expect(
    renderer!.root.findAll((node) => node.props?.testID === 'mermaid-diagram-source')
  ).toHaveLength(0)
})

it('holds the initial transcript reveal until the page diagram settles', async () => {
  const pending = pendingDiagram()
  render.mockImplementationOnce(() => pending.promise)
  const { register, release } = mount(['flowchart TD\nA-->B'])
  expect(register).toHaveBeenCalledOnce()
  expect(release).not.toHaveBeenCalled()
  await act(async () => {
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce())
    pending.resolve({ svg: '<svg>ready</svg>' })
    await pending.promise
  })
  expect(release).toHaveBeenCalledOnce()
})

it('gives a queued diagram its own timeout and discards a timed-out render result', async () => {
  vi.useFakeTimers()
  const first = pendingDiagram()
  render.mockImplementationOnce(() => first.promise).mockResolvedValue({ svg: '<svg>queued</svg>' })
  mount(['flowchart TD\nA-->B', 'flowchart LR\nC-->D'])
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(render).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(
    renderer!.root.findAll((node) => node.props?.testID === 'mermaid-diagram-source')
  ).toHaveLength(1)
  await act(async () => {
    first.resolve({ svg: '<svg>too late</svg>' })
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(render).toHaveBeenCalledTimes(2)
  expect(hosts.some((host) => host.innerHTML.includes('queued'))).toBe(true)
  expect(hosts.every((host) => !host.innerHTML.includes('too late'))).toBe(true)
})

it('releases waiting diagrams to source fallback when the queue never advances', async () => {
  vi.useFakeTimers()
  const first = pendingDiagram()
  render.mockImplementationOnce(() => first.promise)
  const { release } = mount(['flowchart TD\nA-->B', 'flowchart LR\nC-->D'])
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(render).toHaveBeenCalledTimes(1)
  expect(release).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000)
  })
  expect(
    renderer!.root.findAll((node) => node.props?.testID === 'mermaid-diagram-source')
  ).toHaveLength(2)
  expect(release).toHaveBeenCalledTimes(2)
  await act(async () => {
    first.resolve({ svg: '<svg>late</svg>' })
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(render).toHaveBeenCalledTimes(1)
  expect(hosts.every((host) => !host.innerHTML.includes('late'))).toBe(true)
})
