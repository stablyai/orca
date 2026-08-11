/** Response whose body reports cancellation, for asserting that error paths
 *  cancel unread bodies (see unread-response-body.ts). */
export function cancelTrackingResponse(status: number, onCancel: () => void): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('<html>unread error body</html>'))
    },
    cancel() {
      onCancel()
    }
  })
  return new Response(body, { status })
}
