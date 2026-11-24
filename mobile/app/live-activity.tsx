import { useEffect } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { publishLiveActivityLink } from '../src/live-activities/pending-live-activity-link'

export default function LiveActivityRoute() {
  const { id, scope, session } = useLocalSearchParams<{
    id?: string
    scope?: string
    session?: string
  }>()
  useEffect(() => {
    if (typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id)) {
      if (scope !== undefined && (typeof scope !== 'string' || !/^[a-f0-9]{64}$/.test(scope))) {
        return
      }
      if (
        session !== undefined &&
        (typeof session !== 'string' || !/^[a-f0-9]{32}$/.test(session))
      ) {
        return
      }
      publishLiveActivityLink(id, scope, session)
    }
  }, [id, scope, session])
  return null
}
