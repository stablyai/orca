// Package forward reverse-proxies inbound tailnet connections to a loopback
// service. It is how the desktop's WebSocket server becomes reachable over the
// tailnet without binding the WS server to a tailnet interface itself.
package forward

import (
	"io"
	"net"
)

// Splice copies bytes in both directions between a and b. As soon as either
// direction ends (EOF or error), it closes both connections, which unblocks the
// other in-flight copy, then waits for it to finish. This is the standard TCP
// reverse-proxy teardown: a half-open direction must not keep the splice (and
// the goroutines) alive indefinitely.
func Splice(a, b net.Conn) {
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(a, b)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(b, a)
		done <- struct{}{}
	}()
	<-done
	_ = a.Close()
	_ = b.Close()
	<-done
}
