import { useEffect } from 'react'
import { toast } from 'sonner'
import { Toaster } from '@/components/ui/sonner'

/** Shows one toast through `show` in a 600px frame, and clears it when the fixture unmounts. */
export function ToastFixtureStage({ show }: { show: () => void }): React.JSX.Element {
  useEffect(() => {
    show()
    return () => {
      toast.dismiss()
    }
  }, [show])
  // A transform makes this frame the toaster's fixed-position containing block, like a 600px window.
  return (
    <div className="relative h-[360px] w-[600px] [transform:translateZ(0)]">
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
    </div>
  )
}

// Toasts mount and animate in after the first paint; capture once they have.
export async function toastMounted(): Promise<void> {
  const deadline = performance.now() + 3000
  while (!document.querySelector('[data-sonner-toast][data-mounted="true"]')) {
    if (performance.now() > deadline) {
      throw new Error('Timed out waiting for the toast')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  await new Promise((resolve) => setTimeout(resolve, 400))
}
