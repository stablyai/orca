package sshtunnel

import (
	"context"
	"io"
	"net"
	"time"

	"golang.org/x/crypto/ssh"
)

func (t *Tunnel) accept(listener net.Listener, client *ssh.Client, destination string) {
	slots := make(chan struct{}, 8)
	for {
		local, err := listener.Accept()
		if err != nil {
			return
		}
		select {
		case slots <- struct{}{}:
			t.mu.Lock()
			if t.ctx.Err() != nil {
				t.mu.Unlock()
				local.Close()
				return
			}
			t.sockets[local] = struct{}{}
			t.mu.Unlock()
			go func() {
				defer func() { <-slots }()
				defer func() {
					local.Close()
					t.mu.Lock()
					delete(t.sockets, local)
					t.mu.Unlock()
				}()
				ctx, cancel := context.WithTimeout(t.ctx, connectTimeout)
				defer cancel()
				remote, err := client.DialContext(ctx, "tcp", destination)
				if err != nil {
					return
				}
				defer remote.Close()
				done := make(chan struct{}, 2)
				copyStream := func(dst net.Conn, src net.Conn) {
					_, copyErr := io.Copy(dst, src)
					if writer, ok := dst.(interface{ CloseWrite() error }); ok && copyErr == nil {
						_ = writer.CloseWrite()
					} else {
						local.Close()
						remote.Close()
					}
					done <- struct{}{}
				}
				go copyStream(remote, local)
				go copyStream(local, remote)
				<-done
				timer := time.NewTimer(30 * time.Second)
				defer timer.Stop()
				select {
				case <-done:
				case <-t.ctx.Done():
				case <-timer.C:
				}
			}()
		default:
			local.Close()
		}
	}
}
