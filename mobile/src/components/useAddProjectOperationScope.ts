import { useCallback, useEffect, useRef, useState } from 'react'

export type AddProjectOperationScope = {
  client: object | null
  visible: boolean
  openEpoch: number
  selectedTargetId: string | null
  sshCapability: boolean
  selectedTargetAvailable: boolean
}

type Operation = { token: number; scope: AddProjectOperationScope }

function sameScope(a: AddProjectOperationScope, b: AddProjectOperationScope): boolean {
  return (
    a.client === b.client &&
    a.visible === b.visible &&
    a.openEpoch === b.openEpoch &&
    a.selectedTargetId === b.selectedTargetId &&
    a.sshCapability === b.sshCapability &&
    a.selectedTargetAvailable === b.selectedTargetAvailable
  )
}

export function useAddProjectOperationScope(scope: AddProjectOperationScope) {
  const [busyState, setBusyState] = useState({ scope, busy: false })
  const mountedRef = useRef(true)
  const busyRef = useRef(false)
  const tokenRef = useRef(0)
  const previousScopeRef = useRef(scope)
  if (!sameScope(previousScopeRef.current, scope)) {
    previousScopeRef.current = scope
    tokenRef.current += 1
    busyRef.current = false
  }
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  const invalidate = useCallback(() => {
    tokenRef.current += 1
    if (busyRef.current) {
      busyRef.current = false
      setBusyState({ scope: scopeRef.current, busy: false })
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      tokenRef.current += 1
      busyRef.current = false
    }
  }, [])

  const begin = useCallback((expectedScope: AddProjectOperationScope): Operation | null => {
    if (
      busyRef.current ||
      !scopeRef.current.client ||
      !scopeRef.current.visible ||
      !sameScope(scopeRef.current, expectedScope)
    ) {
      return null
    }
    const operation = { token: tokenRef.current + 1, scope: scopeRef.current }
    tokenRef.current = operation.token
    busyRef.current = true
    setBusyState({ scope: scopeRef.current, busy: true })
    return operation
  }, [])

  const current = useCallback((operation: Operation) => {
    return (
      mountedRef.current &&
      busyRef.current &&
      tokenRef.current === operation.token &&
      sameScope(scopeRef.current, operation.scope)
    )
  }, [])

  const finish = useCallback(
    (operation: Operation) => {
      if (current(operation)) {
        busyRef.current = false
        setBusyState({ scope: scopeRef.current, busy: false })
      }
    },
    [current]
  )

  return {
    busy: busyState.busy && sameScope(busyState.scope, scope),
    busyRef,
    begin,
    current,
    finish,
    invalidate
  }
}
