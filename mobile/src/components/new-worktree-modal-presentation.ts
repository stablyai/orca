import { useCallback, useState } from 'react'

export type NewWorktreeModalLayer = 'form' | 'source' | 'repository' | 'agent' | 'setup-trust'

type PresentationState = {
  visible: NewWorktreeModalLayer | null
  exiting: NewWorktreeModalLayer | null
  next: NewWorktreeModalLayer | null
}

const INITIAL_PRESENTATION: PresentationState = {
  visible: 'form',
  exiting: null,
  next: null
}

export function useNewWorktreeModalPresentation() {
  const [state, setState] = useState(INITIAL_PRESENTATION)

  const openLayer = useCallback((layer: Exclude<NewWorktreeModalLayer, 'form'>) => {
    setState((current) =>
      current.visible === 'form' && current.exiting === null
        ? { visible: null, exiting: 'form', next: layer }
        : current
    )
  }, [])

  const closeLayer = useCallback((layer: Exclude<NewWorktreeModalLayer, 'form'>) => {
    setState((current) =>
      current.visible === layer && current.exiting === null
        ? { visible: null, exiting: layer, next: 'form' }
        : current
    )
  }, [])

  const handleLayerHidden = useCallback((layer: NewWorktreeModalLayer) => {
    setState((current) => {
      if (current.exiting === layer) {
        return { visible: current.next, exiting: null, next: null }
      }
      return current.visible === layer && layer !== 'form'
        ? { visible: 'form', exiting: null, next: null }
        : current
    })
  }, [])

  return {
    visibleLayer: state.visible,
    openLayer,
    closeLayer,
    handleLayerHidden
  }
}
