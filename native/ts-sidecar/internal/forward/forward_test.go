package forward

import (
	"io"
	"net"
	"testing"
	"time"
)

// TestSpliceCopiesBothDirections proves bytes written on either outer end reach
// the other, and that closing one end tears the splice down.
func TestSpliceCopiesBothDirections(t *testing.T) {
	a, aPeer := net.Pipe()
	b, bPeer := net.Pipe()

	done := make(chan struct{})
	go func() {
		Splice(a, b)
		close(done)
	}()

	// a -> b direction: write on aPeer, read on bPeer.
	writeRead(t, aPeer, bPeer, "from-a")
	// b -> a direction: write on bPeer, read on aPeer.
	writeRead(t, bPeer, aPeer, "from-b")

	// Closing one outer end must collapse the splice.
	_ = aPeer.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Splice did not return after a peer closed")
	}
}

func writeRead(t *testing.T, from, to net.Conn, msg string) {
	t.Helper()
	go func() {
		_ = from.SetWriteDeadline(time.Now().Add(time.Second))
		_, _ = from.Write([]byte(msg))
	}()
	buf := make([]byte, len(msg))
	_ = to.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := io.ReadFull(to, buf); err != nil {
		t.Fatalf("read %q: %v", msg, err)
	}
	if string(buf) != msg {
		t.Fatalf("got %q, want %q", buf, msg)
	}
}
