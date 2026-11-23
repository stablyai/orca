import { useEffect } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { publishLiveActivityLink } from '../src/live-activities/pending-live-activity-link'

export default function LiveActivityRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>()
  useEffect(() => {
    if (typeof id === 'string') {
      publishLiveActivityLink(id)
    }
  }, [id])
  return null
}
