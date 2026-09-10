import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'

export function hookMount(render: () => void) {
  let renderer: ReactTestRenderer | undefined
  function Harness() {
    render()
    return null
  }
  return {
    mount() {
      act(() => {
        renderer = create(createElement(Harness))
      })
    },
    update() {
      act(() => {
        renderer?.update(createElement(Harness))
      })
    },
    unmount() {
      act(() => {
        renderer?.unmount()
        renderer = undefined
      })
    }
  }
}
