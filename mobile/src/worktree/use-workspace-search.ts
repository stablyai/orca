import { useCallback, useState } from 'react'

export function useWorkspaceSearch() {
  const [search, setSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const toggleSearch = useCallback(() => {
    setSearch('')
    setShowSearch((visible) => !visible)
  }, [])

  return { search, setSearch, showSearch, toggleSearch }
}
