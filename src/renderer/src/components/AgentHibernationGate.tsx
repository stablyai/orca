import { useEffect } from 'react'
import { useAppStore } from '@/store'
import {
  startAgentHibernationCoordinator,
  stopAgentHibernationCoordinator
} from '@/lib/agent-hibernation-coordinator'

export function AgentHibernationGate(): null {
  const enabled = useAppStore((state) => state.settings?.experimentalAgentHibernation === true)

  useEffect(() => {
    if (!enabled) {
      stopAgentHibernationCoordinator()
      return
    }
    return startAgentHibernationCoordinator()
  }, [enabled])

  return null
}
